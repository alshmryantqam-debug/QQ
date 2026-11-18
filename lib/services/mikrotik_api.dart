import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;

class MikroTikApiClient {
  String host;
  int apiPort;
  int restPort;
  bool useHttps;
  String username;
  String password;
  Socket? _socket;
  bool isConnected = false;
  String lastError = '';

  final List<int> _rxBuffer = [];
  Completer<List<Map<String, String>>>? _PendingCommand;
  final List<Map<String, String>> _currentRows = [];

  MikroTikApiClient({
    this.host = '192.168.88.1',
    this.apiPort = 8728,
    this.restPort = 80,
    this.useHttps = false,
    this.username = 'admin',
    this.password = '',
  });

  /// Connect via Native MikroTik API Protocol (TCP Port 8728)
  /// Supports both RouterOS v6.43+ / v7 plain login and legacy MD5 challenge-response
  Future<bool> connectNativeApi({Duration timeout = const Duration(seconds: 5)}) async {
    try {
      await disconnect();
      _socket = await Socket.connect(host, apiPort, timeout: timeout);
      _socket!.listen(
        _onSocketData,
        onError: (e) {
          lastError = e.toString();
          isConnected = false;
          _completePendingWithError();
        },
        onDone: () {
          isConnected = false;
          _completePendingWithError();
        },
      );

      // Step 1: Try modern RouterOS v6.43+ / v7 login
      final loginRes = await sendCommand([
        '/login',
        '=name=$username',
        '=password=$password',
      ], timeout: timeout);

      if (loginRes.isNotEmpty && loginRes.first['!status'] == 'done') {
        // Check if legacy RouterOS returned a challenge token (=ret=...)
        final retChallenge = loginRes.first['ret'];
        if (retChallenge != null && retChallenge.length == 32) {
          final challengeBytes = _hexToBytes(retChallenge);
          final passBytes = utf8.encode(password);
          final digest = md5.convert([0, ...passBytes, ...challengeBytes]).toString();
          final md5Res = await sendCommand([
            '/login',
            '=name=$username',
            '=response=00$digest',
          ], timeout: timeout);
          isConnected = md5Res.isNotEmpty && md5Res.first['!status'] == 'done';
          return isConnected;
        }
        isConnected = true;
        return true;
      }
      isConnected = false;
      return false;
    } catch (e) {
      lastError = e.toString();
      isConnected = false;
      return false;
    }
  }

  /// Execute any real RouterOS API command sentence (e.g. ['/ppp/secret/add', '=name=user1', ...])
  Future<List<Map<String, String>>> sendCommand(
    List<String> words, {
    Duration timeout = const Duration(seconds: 5),
  }) async {
    if (_socket == null) {
      final ok = await connectNativeApi(timeout: timeout);
      if (!ok) return [{'!status': 'error', 'message': lastError}];
    }
    if (_PendingCommand != null && !_PendingCommand!.isCompleted) {
      await _PendingCommand!.future.catchError((_) => <Map<String, String>>[]);
    }

    _currentRows.clear();
    _PendingCommand = Completer<List<Map<String, String>>>();

    try {
      _writeSentence(words);
      return await _PendingCommand!.future.timeout(timeout, onTimeout: () {
        return List<Map<String, String>>.from(_currentRows);
      });
    } catch (e) {
      lastError = e.toString();
      return [{'!status': 'error', 'message': lastError}];
    }
  }

  /// Execute via RouterOS v7 REST API (HTTP/HTTPS)
  Future<dynamic> executeRest(
    String endpoint, {
    String method = 'GET',
    Map<String, dynamic>? payload,
  }) async {
    final scheme = useHttps ? 'https' : 'http';
    final portPart = (restPort == 80 || restPort == 443) ? '' : ':$restPort';
    final cleanEndpoint = endpoint.startsWith('/') ? endpoint : '/$endpoint';
    final uri = Uri.parse('$scheme://$host$portPart/rest$cleanEndpoint');
    final auth = 'Basic ${base64Encode(utf8.encode('$username:$password'))}';
    final headers = <String, String>{
      'Authorization': auth,
      'Content-Type': 'application/json',
    };

    http.Response response;
    if (method == 'POST') {
      response = await http
          .post(uri, headers: headers, body: payload != null ? jsonEncode(payload) : '{}')
          .timeout(const Duration(seconds: 5));
    } else if (method == 'PATCH' || method == 'PUT') {
      response = await http
          .patch(uri, headers: headers, body: payload != null ? jsonEncode(payload) : '{}')
          .timeout(const Duration(seconds: 5));
    } else if (method == 'DELETE') {
      response = await http.delete(uri, headers: headers).timeout(const Duration(seconds: 5));
    } else {
      response = await http.get(uri, headers: headers).timeout(const Duration(seconds: 5));
    }

    if (response.statusCode >= 200 && response.statusCode < 300) {
      if (response.body.trim().isEmpty) return {'status': 'ok'};
      return jsonDecode(response.body);
    } else {
      throw Exception('HTTP ${response.statusCode}: ${response.body}');
    }
  }

  void _onSocketData(List<int> chunk) {
    _rxBuffer.addAll(chunk);
    while (true) {
      final sentence = _tryExtractSentence();
      if (sentence == null) break;
      if (sentence.isEmpty) continue;

      final tag = sentence.first;
      final Map<String, String> row = {'!tag': tag};
      for (int i = 1; i < sentence.length; i++) {
        final w = sentence[i];
        if (w.startsWith('=')) {
          final eqIdx = w.indexOf('=', 1);
          if (eqIdx != -1) {
            row[w.substring(1, eqIdx)] = w.substring(eqIdx + 1);
          }
        }
      }

      if (tag == '!re') {
        _currentRows.add(row);
      } else if (tag == '!done') {
        row['!status'] = 'done';
        if (_currentRows.isEmpty) _currentRows.add(row);
        if (_PendingCommand != null && !_PendingCommand!.isCompleted) {
          _PendingCommand!.complete(List<Map<String, String>>.from(_currentRows));
        }
      } else if (tag == '!trap' || tag == '!fatal') {
        row['!status'] = 'trap';
        _currentRows.add(row);
        if (_PendingCommand != null && !_PendingCommand!.isCompleted) {
          _PendingCommand!.complete(List<Map<String, String>>.from(_currentRows));
        }
      }
    }
  }

  List<String>? _tryExtractSentence() {
    int offset = 0;
    final List<String> words = [];
    while (offset < _rxBuffer.length) {
      final lenResult = _decodeLength(_rxBuffer, offset);
      if (lenResult == null) return null;
      final wordLen = lenResult[0];
      final headerBytes = lenResult[1];
      offset += headerBytes;

      if (wordLen == 0) {
        _rxBuffer.removeRange(0, offset);
        return words;
      }
      if (offset + wordLen > _rxBuffer.length) {
        return null; // Wait for more bytes
      }
      final wordBytes = _rxBuffer.sublist(offset, offset + wordLen);
      words.add(utf8.decode(wordBytes, allowMalformed: true));
      offset += wordLen;
    }
    return null;
  }

  List<int>? _decodeLength(List<int> buf, int pos) {
    if (pos >= buf.length) return null;
    int b0 = buf[pos];
    if ((b0 & 0x80) == 0x00) {
      return [b0, 1];
    } else if ((b0 & 0xC0) == 0x80) {
      if (pos + 1 >= buf.length) return null;
      return [((b0 & 0x3F) << 8) + buf[pos + 1], 2];
    } else if ((b0 & 0xE0) == 0xC0) {
      if (pos + 2 >= buf.length) return null;
      return [((b0 & 0x1F) << 16) + (buf[pos + 1] << 8) + buf[pos + 2], 3];
    } else if ((b0 & 0xF0) == 0xE0) {
      if (pos + 3 >= buf.length) return null;
      return [
        ((b0 & 0x0F) << 24) + (buf[pos + 1] << 16) + (buf[pos + 2] << 8) + buf[pos + 3],
        4
      ];
    }
    return [0, 1];
  }

  void _writeSentence(List<String> words) {
    if (_socket == null) return;
    final List<int> out = [];
    for (final w in words) {
      final b = utf8.encode(w);
      out.addAll(_encodeLength(b.length));
      out.addAll(b);
    }
    out.add(0);
    _socket!.add(out);
  }

  List<int> _encodeLength(int len) {
    if (len < 0x80) return [len];
    if (len < 0x4000) return [(len >> 8) | 0x80, len & 0xFF];
    if (len < 0x200000) return [(len >> 16) | 0xC0, (len >> 8) & 0xFF, len & 0xFF];
    return [0xE0, (len >> 16) & 0xFF, (len >> 8) & 0xFF, len & 0xFF];
  }

  List<int> _hexToBytes(String hex) {
    final List<int> bytes = [];
    for (int i = 0; i < hex.length; i += 2) {
      bytes.add(int.parse(hex.substring(i, i + 2), radix: 16));
    }
    return bytes;
  }

  void _completePendingWithError() {
    if (_PendingCommand != null && !_PendingCommand!.isCompleted) {
      _PendingCommand!.complete([{'!status': 'error', 'message': lastError}]);
    }
  }

  Future<void> disconnect() async {
    try {
      _socket?.destroy();
    } catch (_) {}
    _socket = null;
    isConnected = false;
    _rxBuffer.clear();
  }
}
