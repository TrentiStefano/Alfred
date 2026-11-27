import 'package:flutter/material.dart';

import 'app.dart';

const String _defaultDaemonUrl = String.fromEnvironment(
  'ALFRED_DAEMON_URL',
  defaultValue: 'http://127.0.0.1:4040',
);

void main() {
  runApp(AlfredApp(daemonBaseUri: Uri.parse(_defaultDaemonUrl)));
}
