import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'services/mikrotik_api.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(
    statusBarColor: Color(0xFF030714),
    statusBarIconBrightness: Brightness.light,
    systemNavigationBarColor: Color(0xFF030714),
    systemNavigationBarIconBrightness: Brightness.light,
  ));
  runApp(const NovaRouterApp());
}

class NovaRouterApp extends StatelessWidget {
  const NovaRouterApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'NOVA Router Manager Pro',
      debugShowCheckedModeBanner: false,
      theme: ThemeData.dark().copyWith(
        scaffoldBackgroundColor: const Color(0xFF030714),
      ),
      home: const NovaHybridMasterScreen(),
    );
  }
}

class NovaHybridMasterScreen extends StatefulWidget {
  const NovaHybridMasterScreen({super.key});

  @override
  State<NovaHybridMasterScreen> createState() => _NovaHybridMasterScreenState();
}

class _NovaHybridMasterScreenState extends State<NovaHybridMasterScreen> {
  late final WebViewController _controller;
  final MikroTikApiClient _mikrotik = MikroTikApiClient();
  Timer? _pollTimer;
  bool _isLoaded = false;

  // For real-time Mbps calculation from interface byte counters
  final Map<String, int> _lastRxBytes = {};
  final Map<String, int> _lastTxBytes = {};
  DateTime? _lastPollTime;

  @override
  void initState() {
    super.initState();
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xFF030714))
      ..addJavaScriptChannel(
        'NovaNative',
        onMessageReceived: (JavaScriptMessage message) {
          _handleNativeCommand(message.message);
        },
      )
      ..setNavigationDelegate(
        NavigationDelegate(
          onPageFinished: (_) {
            if (mounted) {
              setState(() => _isLoaded = true);
            }
          },
        ),
      )
      ..loadFlutterAsset('assets/www/index.html');
  }

  Future<void> _handleNativeCommand(String rawJson) async {
    String? reqId;
    try {
      final Map<String, dynamic> cmd = jsonDecode(rawJson);
      final String action = cmd['action'] ?? '';
      reqId = cmd['reqId'];

      if (action == 'CONNECT_MIKROTIK') {
        _mikrotik.host = (cmd['host'] ?? '').toString().trim();
        _mikrotik.apiPort = int.tryParse((cmd['port'] ?? '8728').toString()) ?? 8728;
        _mikrotik.restPort = int.tryParse((cmd['restPort'] ?? '80').toString()) ?? 80;
        _mikrotik.username = (cmd['user'] ?? 'admin').toString().trim();
        _mikrotik.password = (cmd['pass'] ?? '').toString();

        final connected = await _mikrotik.connectNativeApi();
        if (connected) {
          _lastRxBytes.clear();
          _lastTxBytes.clear();
          _lastPollTime = null;
          _startHardwarePolling();
          // Reply immediately after authentication; telemetry must not delay login.
          unawaited(_pollOnce());
        }
        if (reqId != null) {
          _sendRpcReply(reqId, {
            'ok': connected,
            'mode': connected ? 'NATIVE_TCP_8728' : 'ERROR',
            'error': _mikrotik.lastError,
            'rows': []
          });
        }
      } else if (action == 'DISCONNECT_MIKROTIK') {
        _pollTimer?.cancel();
        await _mikrotik.disconnect();
        if (reqId != null) {
          _sendRpcReply(reqId, {'ok': true, 'mode': 'DISCONNECTED', 'rows': []});
        }
      } else if (action == 'EXEC_COMMAND') {
        final List<dynamic> rawWords = cmd['words'] ?? [];
        final List<String> words = rawWords.map((e) => e.toString()).toList();
        final rows = await _mikrotik.sendCommand(words);
        final bool isTrap = rows.isNotEmpty && (rows.first['!status'] == 'trap' || rows.first['!status'] == 'error');
        if (reqId != null) {
          _sendRpcReply(reqId, {
            'ok': !isTrap,
            'mode': 'NATIVE_TCP_8728',
            'rows': rows,
            'error': isTrap ? (rows.first['message'] ?? _mikrotik.lastError) : null,
          });
        }
      }
    } catch (e) {
      if (reqId != null) {
        _sendRpcReply(reqId!, {
          'ok': false,
          'mode': 'ERROR',
          'error': e.toString(),
          'rows': [],
        });
      }
    }
  }

  void _sendRpcReply(String reqId, Map<String, dynamic> data) {
    data['reqId'] = reqId;
    final encoded = jsonEncode(data);
    _controller.runJavaScript('window.onNovaNativeResponse($encoded);');
  }

  void _startHardwarePolling() {
    _pollTimer?.cancel();
    _pollTimer = Timer.periodic(const Duration(seconds: 2), (_) => _pollOnce());
  }

  Future<void> _pollOnce() async {
    if (!_mikrotik.isConnected) return;
    try {
      final now = DateTime.now();
      final elapsedSec = _lastPollTime != null
          ? (now.difference(_lastPollTime!).inMilliseconds / 1000.0)
          : 2.0;
      _lastPollTime = now;

      final res = await _mikrotik.sendCommand(['/system/resource/print']);
      final health = await _mikrotik.sendCommand(['/system/health/print']);
      final ifaces = await _mikrotik.sendCommand(['/interface/print']);

      String cpu = '0';
      int ram = 0;
      String uptime = '--';
      String boardName = 'MikroTik';
      String version = '';

      if (res.isNotEmpty && res.first['!status'] != 'error') {
        final r = res.first;
        cpu = r['cpu-load'] ?? '0';
        uptime = r['uptime'] ?? '--';
        boardName = r['board-name'] ?? r['platform'] ?? 'MikroTik';
        version = r['version'] ?? '';
        final freeMem = double.tryParse(r['free-memory'] ?? '0') ?? 0;
        final totalMem = double.tryParse(r['total-memory'] ?? '1') ?? 1;
        if (totalMem > 0) {
          ram = (((totalMem - freeMem) / totalMem) * 100).round();
        }
      }

      String? temp;
      String? voltage;
      for (final h in health) {
        final name = (h['name'] ?? '').toLowerCase();
        if (name.contains('temp')) {
          temp = h['value'];
        } else if (name.contains('volt')) {
          voltage = h['value'];
        }
        if (h.containsKey('temperature')) temp = h['temperature'];
        if (h.containsKey('cpu-temperature')) temp = h['cpu-temperature'];
        if (h.containsKey('voltage')) voltage = h['voltage'];
      }

      // Compute exact Mbps per interface from rx-byte / tx-byte deltas
      final Map<String, Map<String, dynamic>> ifaceRates = {};
      for (final iface in ifaces) {
        final name = iface['name'] ?? '';
        if (name.isEmpty) continue;
        final rxB = int.tryParse(iface['rx-byte'] ?? '0') ?? 0;
        final txB = int.tryParse(iface['tx-byte'] ?? '0') ?? 0;
        double rxMbps = 0.0;
        double txMbps = 0.0;
        if (_lastRxBytes.containsKey(name) && elapsedSec > 0.2) {
          final dRx = rxB - _lastRxBytes[name]!;
          final dTx = txB - _lastTxBytes[name]!;
          if (dRx >= 0) rxMbps = (dRx * 8.0) / (elapsedSec * 1000000.0);
          if (dTx >= 0) txMbps = (dTx * 8.0) / (elapsedSec * 1000000.0);
        }
        _lastRxBytes[name] = rxB;
        _lastTxBytes[name] = txB;
        ifaceRates[name] = {
          'name': name,
          'type': iface['type'] ?? '',
          'running': iface['running'] == 'true',
          'disabled': iface['disabled'] == 'true',
          'rxMbps': double.parse(rxMbps.toStringAsFixed(1)),
          'txMbps': double.parse(txMbps.toStringAsFixed(1)),
          'rxBytes': rxB,
          'txBytes': txB,
        };
      }

      final payload = jsonEncode({
        'cpu': cpu,
        'ram': ram,
        'uptime': uptime,
        'boardName': boardName,
        'version': version,
        if (temp != null) 'temp': temp,
        if (voltage != null) 'voltage': voltage,
        'interfaces': ifaceRates,
      });
      _controller.runJavaScript('window.onMikroTikLiveTelemetry($payload);');
    } catch (_) {}
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    _mikrotik.disconnect();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF030714),
      body: SafeArea(
        child: Stack(
          children: [
            WebViewWidget(controller: _controller),
            if (!_isLoaded)
              const Center(
                child: CircularProgressIndicator(
                  color: Color(0xFF00E5FF),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
