import 'package:flutter/material.dart';

import 'app.dart';
import 'daemon_health.dart';

const String _defaultDaemonUrl = String.fromEnvironment(
  'ALFRED_DAEMON_URL',
  defaultValue: kDefaultDaemonUrl,
);

void main() {
  runApp(AlfredApp(daemonBaseUri: Uri.parse(_defaultDaemonUrl)));
}
