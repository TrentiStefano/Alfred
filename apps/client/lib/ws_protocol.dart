import 'daemon_health.dart';

const String kDefaultMainThreadId = 'main';
const String kDefaultMainAgentName = 'Alfred';

enum ThreadMessageRole {
  owner('owner'),
  agent('agent');

  const ThreadMessageRole(this.wireValue);
  final String wireValue;

  static ThreadMessageRole parse(Object? value) {
    for (final ThreadMessageRole role in values) {
      if (role.wireValue == value) {
        return role;
      }
    }
    throw FormatException('Invalid thread message role: $value');
  }
}

enum ThreadMessageStatus {
  complete('complete'),
  streaming('streaming'),
  error('error'),
  interrupted('interrupted');

  const ThreadMessageStatus(this.wireValue);
  final String wireValue;

  static ThreadMessageStatus parse(Object? value) {
    for (final ThreadMessageStatus status in values) {
      if (status.wireValue == value) {
        return status;
      }
    }
    throw FormatException('Invalid thread message status: $value');
  }
}

enum ThreadStatus {
  idle('idle'),
  streaming('streaming'),
  error('error');

  const ThreadStatus(this.wireValue);
  final String wireValue;

  static ThreadStatus parse(Object? value) {
    for (final ThreadStatus status in values) {
      if (status.wireValue == value) {
        return status;
      }
    }
    throw FormatException('Invalid thread status: $value');
  }
}

enum ProtocolErrorCode {
  handshakeRequired('handshake_required'),
  unsupportedProtocolVersion('unsupported_protocol_version'),
  invalidMessage('invalid_message'),
  unknownThread('unknown_thread'),
  invalidState('invalid_state'),
  runtimeError('runtime_error');

  const ProtocolErrorCode(this.wireValue);
  final String wireValue;

  static ProtocolErrorCode parse(Object? value) {
    for (final ProtocolErrorCode code in values) {
      if (code.wireValue == value) {
        return code;
      }
    }
    throw FormatException('Invalid protocol error code: $value');
  }
}

class HelloClientInfo {
  const HelloClientInfo({required this.name, this.version, this.platform});

  final String name;
  final String? version;
  final String? platform;

  static HelloClientInfo fromJsonObject(Object? decoded) {
    final Map<String, Object?> map = _expectStrictObject(
      decoded,
      allowedKeys: const <String>{'name', 'version', 'platform'},
      context: 'HelloClientInfo',
    );
    return HelloClientInfo(
      name: _expectNonEmptyString(map['name'], 'client.name'),
      version: _expectOptionalNonEmptyString(map['version'], 'client.version'),
      platform: _expectOptionalNonEmptyString(
        map['platform'],
        'client.platform',
      ),
    );
  }

  Map<String, Object?> toJson() {
    return <String, Object?>{
      'name': name,
      if (version != null) 'version': version,
      if (platform != null) 'platform': platform,
    };
  }
}

sealed class ClientMessage {
  const ClientMessage();

  Map<String, Object?> toJson();

  static ClientMessage fromJsonObject(Object? decoded) {
    final Map<String, Object?> map = _expectObject(decoded, 'ClientMessage');
    final Object? type = map['type'];
    return switch (type) {
      'hello' => ClientHelloMessage.fromJsonObject(map),
      'submit' => ClientSubmitMessage.fromJsonObject(map),
      _ => throw FormatException('Unknown client message type: $type'),
    };
  }
}

final class ClientHelloMessage extends ClientMessage {
  const ClientHelloMessage({
    this.protocolVersion = kExpectedProtocolVersion,
    this.client,
  });

  final int protocolVersion;
  final HelloClientInfo? client;

  static ClientHelloMessage fromJsonObject(Object? decoded) {
    final Map<String, Object?> map = _expectStrictObject(
      decoded,
      allowedKeys: const <String>{'type', 'protocolVersion', 'client'},
      context: 'hello',
    );
    _expectLiteral(map['type'], 'hello', 'hello.type');
    final int version = _expectPositiveInt(
      map['protocolVersion'],
      'hello.protocolVersion',
    );
    final Object? rawClient = map['client'];
    return ClientHelloMessage(
      protocolVersion: version,
      client: rawClient == null
          ? null
          : HelloClientInfo.fromJsonObject(rawClient),
    );
  }

  @override
  Map<String, Object?> toJson() {
    return <String, Object?>{
      'type': 'hello',
      'protocolVersion': protocolVersion,
      if (client != null) 'client': client!.toJson(),
    };
  }
}

final class ClientSubmitMessage extends ClientMessage {
  const ClientSubmitMessage({
    required this.threadId,
    required this.requestId,
    required this.text,
  });

  final String threadId;
  final String requestId;
  final String text;

  static ClientSubmitMessage fromJsonObject(Object? decoded) {
    final Map<String, Object?> map = _expectStrictObject(
      decoded,
      allowedKeys: const <String>{'type', 'threadId', 'requestId', 'text'},
      context: 'submit',
    );
    _expectLiteral(map['type'], 'submit', 'submit.type');
    return ClientSubmitMessage(
      threadId: _expectNonEmptyString(map['threadId'], 'submit.threadId'),
      requestId: _expectNonEmptyString(map['requestId'], 'submit.requestId'),
      text: _expectNonBlankString(map['text'], 'submit.text'),
    );
  }

  @override
  Map<String, Object?> toJson() {
    return <String, Object?>{
      'type': 'submit',
      'threadId': threadId,
      'requestId': requestId,
      'text': text,
    };
  }
}

class ThreadMessage {
  const ThreadMessage({
    required this.id,
    required this.role,
    required this.text,
    required this.status,
    required this.createdAt,
    this.requestId,
  });

  final String id;
  final ThreadMessageRole role;
  final String text;
  final ThreadMessageStatus status;
  final String? requestId;
  final String createdAt;

  static ThreadMessage fromJsonObject(Object? decoded) {
    final Map<String, Object?> map = _expectStrictObject(
      decoded,
      allowedKeys: const <String>{
        'id',
        'role',
        'text',
        'status',
        'requestId',
        'createdAt',
      },
      context: 'ThreadMessage',
    );
    final Object? rawText = map['text'];
    if (rawText is! String) {
      throw const FormatException('ThreadMessage.text must be a string.');
    }
    final String createdAt = _expectNonEmptyString(
      map['createdAt'],
      'ThreadMessage.createdAt',
    );
    if (DateTime.tryParse(createdAt) == null) {
      throw FormatException(
        'ThreadMessage.createdAt must be an ISO-8601 timestamp: $createdAt',
      );
    }
    return ThreadMessage(
      id: _expectNonEmptyString(map['id'], 'ThreadMessage.id'),
      role: ThreadMessageRole.parse(map['role']),
      text: rawText,
      status: ThreadMessageStatus.parse(map['status']),
      requestId: _expectOptionalNonEmptyString(
        map['requestId'],
        'ThreadMessage.requestId',
      ),
      createdAt: createdAt,
    );
  }

  Map<String, Object?> toJson() {
    return <String, Object?>{
      'id': id,
      'role': role.wireValue,
      'text': text,
      'status': status.wireValue,
      if (requestId != null) 'requestId': requestId,
      'createdAt': createdAt,
    };
  }
}

class ThreadSnapshot {
  const ThreadSnapshot({
    required this.id,
    required this.agentName,
    required this.status,
    required this.messages,
  });

  final String id;
  final String agentName;
  final ThreadStatus status;
  final List<ThreadMessage> messages;

  static ThreadSnapshot fromJsonObject(Object? decoded) {
    final Map<String, Object?> map = _expectStrictObject(
      decoded,
      allowedKeys: const <String>{'id', 'agentName', 'status', 'messages'},
      context: 'ThreadSnapshot',
    );
    final Object? rawMessages = map['messages'];
    if (rawMessages is! List<Object?>) {
      throw const FormatException('ThreadSnapshot.messages must be a list.');
    }
    return ThreadSnapshot(
      id: _expectNonEmptyString(map['id'], 'ThreadSnapshot.id'),
      agentName: _expectNonEmptyString(
        map['agentName'],
        'ThreadSnapshot.agentName',
      ),
      status: ThreadStatus.parse(map['status']),
      messages: rawMessages
          .map(ThreadMessage.fromJsonObject)
          .toList(growable: false),
    );
  }

  Map<String, Object?> toJson() {
    return <String, Object?>{
      'id': id,
      'agentName': agentName,
      'status': status.wireValue,
      'messages': messages
          .map((ThreadMessage message) => message.toJson())
          .toList(growable: false),
    };
  }
}

sealed class DaemonMessage {
  const DaemonMessage();

  Map<String, Object?> toJson();

  static DaemonMessage fromJsonObject(Object? decoded) {
    final Map<String, Object?> map = _expectObject(decoded, 'DaemonMessage');
    final Object? type = map['type'];
    return switch (type) {
      'snapshot' => DaemonSnapshotMessage.fromJsonObject(map),
      'ack' => DaemonAckMessage.fromJsonObject(map),
      'error' => DaemonErrorMessage.fromJsonObject(map),
      _ => throw FormatException('Unknown daemon message type: $type'),
    };
  }
}

final class DaemonSnapshotMessage extends DaemonMessage {
  const DaemonSnapshotMessage({
    required this.protocolVersion,
    required this.seq,
    required this.thread,
  });

  final int protocolVersion;
  final int seq;
  final ThreadSnapshot thread;

  static DaemonSnapshotMessage fromJsonObject(Object? decoded) {
    final Map<String, Object?> map = _expectStrictObject(
      decoded,
      allowedKeys: const <String>{'type', 'protocolVersion', 'seq', 'thread'},
      context: 'snapshot',
    );
    _expectLiteral(map['type'], 'snapshot', 'snapshot.type');
    return DaemonSnapshotMessage(
      protocolVersion: _expectPositiveInt(
        map['protocolVersion'],
        'snapshot.protocolVersion',
      ),
      seq: _expectNonNegativeInt(map['seq'], 'snapshot.seq'),
      thread: ThreadSnapshot.fromJsonObject(map['thread']),
    );
  }

  @override
  Map<String, Object?> toJson() {
    return <String, Object?>{
      'type': 'snapshot',
      'protocolVersion': protocolVersion,
      'seq': seq,
      'thread': thread.toJson(),
    };
  }
}

final class DaemonAckMessage extends DaemonMessage {
  const DaemonAckMessage({
    required this.threadId,
    required this.requestId,
    required this.submissionId,
    this.deduplicated,
  });

  final String threadId;
  final String requestId;
  final String submissionId;
  final bool? deduplicated;

  static DaemonAckMessage fromJsonObject(Object? decoded) {
    final Map<String, Object?> map = _expectStrictObject(
      decoded,
      allowedKeys: const <String>{
        'type',
        'threadId',
        'requestId',
        'submissionId',
        'deduplicated',
      },
      context: 'ack',
    );
    _expectLiteral(map['type'], 'ack', 'ack.type');
    final Object? rawDeduplicated = map['deduplicated'];
    if (rawDeduplicated != null && rawDeduplicated is! bool) {
      throw const FormatException('ack.deduplicated must be a boolean.');
    }
    return DaemonAckMessage(
      threadId: _expectNonEmptyString(map['threadId'], 'ack.threadId'),
      requestId: _expectNonEmptyString(map['requestId'], 'ack.requestId'),
      submissionId: _expectNonEmptyString(
        map['submissionId'],
        'ack.submissionId',
      ),
      deduplicated: rawDeduplicated as bool?,
    );
  }

  @override
  Map<String, Object?> toJson() {
    return <String, Object?>{
      'type': 'ack',
      'threadId': threadId,
      'requestId': requestId,
      'submissionId': submissionId,
      if (deduplicated != null) 'deduplicated': deduplicated,
    };
  }
}

final class DaemonErrorMessage extends DaemonMessage {
  const DaemonErrorMessage({
    required this.code,
    required this.message,
    this.protocolVersion,
    this.expectedProtocolVersion,
    this.threadId,
    this.requestId,
  });

  final ProtocolErrorCode code;
  final String message;
  final int? protocolVersion;
  final int? expectedProtocolVersion;
  final String? threadId;
  final String? requestId;

  static DaemonErrorMessage fromJsonObject(Object? decoded) {
    final Map<String, Object?> map = _expectStrictObject(
      decoded,
      allowedKeys: const <String>{
        'type',
        'code',
        'message',
        'protocolVersion',
        'expectedProtocolVersion',
        'threadId',
        'requestId',
      },
      context: 'error',
    );
    _expectLiteral(map['type'], 'error', 'error.type');
    return DaemonErrorMessage(
      code: ProtocolErrorCode.parse(map['code']),
      message: _expectNonEmptyString(map['message'], 'error.message'),
      protocolVersion: _expectOptionalPositiveInt(
        map['protocolVersion'],
        'error.protocolVersion',
      ),
      expectedProtocolVersion: _expectOptionalPositiveInt(
        map['expectedProtocolVersion'],
        'error.expectedProtocolVersion',
      ),
      threadId: _expectOptionalNonEmptyString(
        map['threadId'],
        'error.threadId',
      ),
      requestId: _expectOptionalNonEmptyString(
        map['requestId'],
        'error.requestId',
      ),
    );
  }

  @override
  Map<String, Object?> toJson() {
    return <String, Object?>{
      'type': 'error',
      'code': code.wireValue,
      'message': message,
      if (protocolVersion != null) 'protocolVersion': protocolVersion,
      if (expectedProtocolVersion != null)
        'expectedProtocolVersion': expectedProtocolVersion,
      if (threadId != null) 'threadId': threadId,
      if (requestId != null) 'requestId': requestId,
    };
  }
}

Map<String, Object?> _expectObject(Object? decoded, String context) {
  if (decoded is! Map<Object?, Object?>) {
    throw FormatException('$context must be a JSON object.');
  }
  final Map<String, Object?> result = <String, Object?>{};
  for (final MapEntry<Object?, Object?> entry in decoded.entries) {
    final Object? key = entry.key;
    if (key is! String) {
      throw FormatException('$context keys must be strings.');
    }
    result[key] = entry.value;
  }
  return result;
}

Map<String, Object?> _expectStrictObject(
  Object? decoded, {
  required Set<String> allowedKeys,
  required String context,
}) {
  final Map<String, Object?> map = _expectObject(decoded, context);
  for (final String key in map.keys) {
    if (!allowedKeys.contains(key)) {
      throw FormatException('$context contains unexpected field "$key".');
    }
  }
  return map;
}

void _expectLiteral(Object? value, String expected, String field) {
  if (value != expected) {
    throw FormatException('$field must equal "$expected".');
  }
}

String _expectNonEmptyString(Object? value, String field) {
  if (value is! String || value.isEmpty) {
    throw FormatException('$field must be a non-empty string.');
  }
  return value;
}

String _expectNonBlankString(Object? value, String field) {
  if (value is! String || value.trim().isEmpty) {
    throw FormatException('$field must be a non-blank string.');
  }
  return value;
}

String? _expectOptionalNonEmptyString(Object? value, String field) {
  if (value == null) {
    return null;
  }
  return _expectNonEmptyString(value, field);
}

int _expectPositiveInt(Object? value, String field) {
  if (value is! int || value <= 0) {
    throw FormatException('$field must be a positive integer.');
  }
  return value;
}

int? _expectOptionalPositiveInt(Object? value, String field) {
  if (value == null) {
    return null;
  }
  return _expectPositiveInt(value, field);
}

int _expectNonNegativeInt(Object? value, String field) {
  if (value is! int || value < 0) {
    throw FormatException('$field must be a non-negative integer.');
  }
  return value;
}
