import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';

import 'app.dart';
import 'daemon_config.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SemanticsBinding.instance.ensureSemantics();
  runApp(AlfredApp(daemonBaseUri: resolveDaemonBaseUri()));
}
