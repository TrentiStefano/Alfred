import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import 'thread_screen.dart';
import 'ws_client.dart';

export 'health_screen.dart' show HealthCheckScreen;

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
