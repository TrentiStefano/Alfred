import 'dart:async';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import 'health_screen.dart';
import 'ws_client.dart';
import 'ws_protocol.dart';

/// Main Agent Thread screen backed by the daemon `/ws` protocol.
class ThreadScreen extends StatefulWidget {
  const ThreadScreen({
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
  State<ThreadScreen> createState() => _ThreadScreenState();
}

class _ThreadScreenState extends State<ThreadScreen> {
  late final AlfredWsClient _client;
  final TextEditingController _composerController = TextEditingController();
  bool _hasDraft = false;

  @override
  void initState() {
    super.initState();
    _client = AlfredWsClient(
      daemonBaseUri: widget.daemonBaseUri,
      channelFactory: widget.webSocketChannelFactory,
      requestIdGenerator: widget.requestIdGenerator,
      reconnectDelay: widget.reconnectDelay,
      maxReconnectAttempts: widget.maxReconnectAttempts,
    );
    _composerController.addListener(_onDraftChanged);
    _client.connect();
  }

  @override
  void dispose() {
    _composerController.removeListener(_onDraftChanged);
    _composerController.dispose();
    _client.dispose();
    super.dispose();
  }

  void _onDraftChanged() {
    final bool hasDraft = _composerController.text.trim().isNotEmpty;
    if (hasDraft != _hasDraft) {
      setState(() {
        _hasDraft = hasDraft;
      });
    }
  }

  void _handleSubmit() {
    final String text = _composerController.text;
    if (text.trim().isEmpty || !_client.canSubmit) {
      return;
    }
    _client.submitPrompt(text);
    _composerController.clear();
  }

  void _openHealthScreen() {
    unawaited(
      Navigator.of(context).push<void>(
        MaterialPageRoute<void>(
          builder: (BuildContext _) => HealthCheckScreen(
            daemonBaseUri: widget.daemonBaseUri,
            httpClient: widget.httpClient,
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: _client,
      builder: (BuildContext context, Widget? _) {
        final ThreadSnapshot? thread = _client.thread;
        final ThreadConnectionStatus status = _client.status;
        final String agentName = thread?.agentName ?? kDefaultMainAgentName;
        final bool canReconnect =
            status == ThreadConnectionStatus.disconnected ||
            status == ThreadConnectionStatus.error;

        return Scaffold(
          appBar: AppBar(
            title: Text(agentName),
            actions: <Widget>[
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8),
                child: _StatusChip(status: status),
              ),
              if (canReconnect)
                Padding(
                  padding: const EdgeInsets.only(right: 4),
                  child: OutlinedButton(
                    onPressed: _client.connect,
                    child: const Text('Reconnect'),
                  ),
                ),
              IconButton(
                icon: const Icon(Icons.monitor_heart_outlined),
                tooltip: 'Daemon health',
                onPressed: _openHealthScreen,
              ),
            ],
          ),
          body: Column(
            children: <Widget>[
              if (_client.errorMessage != null)
                _ErrorBanner(message: _client.errorMessage!),
              if (_client.turnErrorMessage != null)
                _ErrorBanner(
                  message:
                      '$agentName could not finish the last reply: ${_client.turnErrorMessage!}',
                ),
              Expanded(child: _buildMessages(thread, status)),
              _buildComposer(agentName, status),
            ],
          ),
        );
      },
    );
  }

  Widget _buildMessages(ThreadSnapshot? thread, ThreadConnectionStatus status) {
    final List<ThreadMessage> messages =
        thread?.messages ?? const <ThreadMessage>[];
    if (messages.isEmpty) {
      final String emptyText = switch (status) {
        ThreadConnectionStatus.connecting => 'Connecting to Alfred...',
        ThreadConnectionStatus.connected =>
          'Send a message to start a Thread with ${thread?.agentName ?? kDefaultMainAgentName}.',
        ThreadConnectionStatus.streaming => 'Alfred is responding...',
        ThreadConnectionStatus.reconnecting => 'Reconnecting to daemon...',
        ThreadConnectionStatus.disconnected =>
          'Disconnected — unable to reach daemon.',
        ThreadConnectionStatus.error => 'Unable to load Thread.',
      };
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(emptyText, textAlign: TextAlign.center),
        ),
      );
    }

    final String agentName = thread?.agentName ?? kDefaultMainAgentName;
    return ListView.separated(
      padding: const EdgeInsets.all(16),
      itemCount: messages.length,
      separatorBuilder: (BuildContext _, int _) => const SizedBox(height: 12),
      itemBuilder: (BuildContext context, int index) {
        final ThreadMessage message = messages[index];
        return _MessageBubble(message: message, agentName: agentName);
      },
    );
  }

  Widget _buildComposer(String agentName, ThreadConnectionStatus status) {
    final bool canSubmit = _client.canSubmit;
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
        child: Row(
          children: <Widget>[
            Expanded(
              child: TextField(
                controller: _composerController,
                enabled: canSubmit,
                textInputAction: TextInputAction.send,
                onSubmitted: (String _) => _handleSubmit(),
                decoration: InputDecoration(
                  hintText: 'Message $agentName...',
                  border: const OutlineInputBorder(),
                ),
              ),
            ),
            const SizedBox(width: 12),
            FilledButton(
              onPressed: canSubmit && _hasDraft ? _handleSubmit : null,
              child: const Text('Send'),
            ),
          ],
        ),
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.status});

  final ThreadConnectionStatus status;

  @override
  Widget build(BuildContext context) {
    final ColorScheme colors = Theme.of(context).colorScheme;
    final Color background = switch (status) {
      ThreadConnectionStatus.connected => colors.primaryContainer,
      ThreadConnectionStatus.connecting => colors.secondaryContainer,
      ThreadConnectionStatus.streaming => colors.tertiaryContainer,
      ThreadConnectionStatus.reconnecting => colors.secondaryContainer,
      ThreadConnectionStatus.disconnected => colors.surfaceContainerHighest,
      ThreadConnectionStatus.error => colors.errorContainer,
    };
    final Color foreground = switch (status) {
      ThreadConnectionStatus.connected => colors.onPrimaryContainer,
      ThreadConnectionStatus.connecting => colors.onSecondaryContainer,
      ThreadConnectionStatus.streaming => colors.onTertiaryContainer,
      ThreadConnectionStatus.reconnecting => colors.onSecondaryContainer,
      ThreadConnectionStatus.disconnected => colors.onSurfaceVariant,
      ThreadConnectionStatus.error => colors.onErrorContainer,
    };

    return Semantics(
      container: true,
      liveRegion: true,
      label: 'Connection status: ${status.label}',
      excludeSemantics: true,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        decoration: BoxDecoration(
          color: background,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Text(
          status.label,
          style: TextStyle(
            color: foreground,
            fontSize: 12,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final ColorScheme colors = Theme.of(context).colorScheme;
    return Semantics(
      container: true,
      liveRegion: true,
      child: Container(
        width: double.infinity,
        color: colors.errorContainer,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        child: Text(message, style: TextStyle(color: colors.onErrorContainer)),
      ),
    );
  }
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({required this.message, required this.agentName});

  final ThreadMessage message;
  final String agentName;

  @override
  Widget build(BuildContext context) {
    final bool isOwner = message.role == ThreadMessageRole.owner;
    final ColorScheme colors = Theme.of(context).colorScheme;
    final Color background = isOwner
        ? colors.primaryContainer
        : colors.surfaceContainerHighest;
    final Color foreground = isOwner
        ? colors.onPrimaryContainer
        : colors.onSurface;
    final String speaker = isOwner ? 'Owner' : agentName;

    return Semantics(
      container: true,
      label: '$speaker (${message.status.wireValue}): ${message.text}',
      excludeSemantics: true,
      child: Align(
        alignment: isOwner ? Alignment.centerRight : Alignment.centerLeft,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560),
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: background,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    speaker,
                    style: TextStyle(
                      color: foreground.withValues(alpha: 0.75),
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(message.text, style: TextStyle(color: foreground)),
                  if (message.status !=
                      ThreadMessageStatus.complete) ...<Widget>[
                    const SizedBox(height: 4),
                    Text(
                      message.status.wireValue,
                      style: TextStyle(
                        color: foreground.withValues(alpha: 0.7),
                        fontSize: 11,
                        fontStyle: FontStyle.italic,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
