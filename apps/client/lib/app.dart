import 'dart:async';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import 'daemon_health.dart';
import 'thread_screen.dart';
import 'ws_client.dart';

const TextStyle _headingStyle = TextStyle(
  fontSize: 20,
  fontWeight: FontWeight.w600,
);

class AlfredApp extends StatelessWidget {
  const AlfredApp({
    super.key,
    required this.daemonBaseUri,
    this.httpClient,
    this.webSocketChannelFactory,
    this.requestIdGenerator,
    this.reconnectDelay,
    this.maxReconnectAttempts = 5,
  });

  final Uri daemonBaseUri;
  final http.Client? httpClient;
  final WebSocketChannelFactory? webSocketChannelFactory;
  final String Function()? requestIdGenerator;
  final ReconnectDelayBuilder? reconnectDelay;
  final int maxReconnectAttempts;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Alfred',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal),
      ),
      home: ThreadScreen(
        daemonBaseUri: daemonBaseUri,
        httpClient: httpClient,
        webSocketChannelFactory: webSocketChannelFactory,
        requestIdGenerator: requestIdGenerator,
        reconnectDelay: reconnectDelay,
        maxReconnectAttempts: maxReconnectAttempts,
      ),
    );
  }
}

class HealthCheckScreen extends StatefulWidget {
  const HealthCheckScreen({
    super.key,
    required this.daemonBaseUri,
    this.httpClient,
  });

  final Uri daemonBaseUri;
  final http.Client? httpClient;

  @override
  State<HealthCheckScreen> createState() => _HealthCheckScreenState();
}

sealed class _HealthViewState {
  const _HealthViewState();
}

final class _LoadingState extends _HealthViewState {
  const _LoadingState();
}

final class _LoadedState extends _HealthViewState {
  const _LoadedState(this.health);

  final DaemonHealth health;
}

final class _ErrorState extends _HealthViewState {
  const _ErrorState(this.message);

  final String message;
}

class _HealthCheckScreenState extends State<HealthCheckScreen> {
  late final http.Client _client;
  late final bool _ownsClient;
  _HealthViewState _state = const _LoadingState();

  @override
  void initState() {
    super.initState();
    _ownsClient = widget.httpClient == null;
    _client = widget.httpClient ?? http.Client();
    unawaited(_checkHealth());
  }

  @override
  void dispose() {
    if (_ownsClient) {
      _client.close();
    }
    super.dispose();
  }

  Future<void> _checkHealth() async {
    if (mounted) {
      setState(() {
        _state = const _LoadingState();
      });
    }
    try {
      final DaemonHealth health = await fetchDaemonHealth(
        baseUri: widget.daemonBaseUri,
        client: _client,
      );
      if (!mounted) return;
      setState(() {
        _state = _LoadedState(health);
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _state = _ErrorState(error.toString());
      });
    }
  }

  void _handleRetry() {
    unawaited(_checkHealth());
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Alfred')),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: _buildBody(),
          ),
        ),
      ),
    );
  }

  Widget _buildBody() {
    return switch (_state) {
      _LoadingState() => const Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          CircularProgressIndicator(),
          SizedBox(height: 16),
          Text('Checking daemon health...'),
        ],
      ),
      _LoadedState(:final DaemonHealth health) => _buildLoaded(health),
      _ErrorState(:final String message) => Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          const Text('Daemon unreachable', style: _headingStyle),
          const SizedBox(height: 8),
          Text(message, textAlign: TextAlign.center),
          const SizedBox(height: 16),
          FilledButton(onPressed: _handleRetry, child: const Text('Retry')),
        ],
      ),
    };
  }

  Widget _buildLoaded(DaemonHealth health) {
    final bool compatible = health.isProtocolCompatible();
    final String heading = !compatible
        ? 'Incompatible protocol'
        : health.ok
        ? 'Daemon connected'
        : 'Daemon unhealthy';
    final String versionLabel = compatible
        ? 'Protocol v${health.protocolVersion} (compatible)'
        : 'Protocol v${health.protocolVersion} (expected v$kExpectedProtocolVersion)';

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Text(heading, style: _headingStyle),
        const SizedBox(height: 8),
        Text(health.service),
        const SizedBox(height: 4),
        Text(versionLabel),
        const SizedBox(height: 16),
        OutlinedButton(onPressed: _handleRetry, child: const Text('Refresh')),
      ],
    );
  }
}
