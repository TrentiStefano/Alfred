import 'daemon_config_stub.dart'
    if (dart.library.js_interop) 'daemon_config_web.dart'
    if (dart.library.io) 'daemon_config_io.dart'
    as platform;
import 'daemon_health.dart';

const String _compileTimeDaemonUrl = String.fromEnvironment(
  'ALFRED_DAEMON_URL',
  defaultValue: kDefaultDaemonUrl,
);

/// Parses [raw] if it is a valid `http` or `https` URI with an authority.
Uri? parseValidDaemonUri(String? raw) {
  if (raw == null) {
    return null;
  }
  final String trimmed = raw.trim();
  if (trimmed.isEmpty) {
    return null;
  }
  final Uri? parsed = Uri.tryParse(trimmed);
  if (parsed == null || !parsed.hasAuthority || parsed.host.isEmpty) {
    return null;
  }
  if (parsed.scheme != 'http' && parsed.scheme != 'https') {
    return null;
  }
  return parsed;
}

/// Resolves `?daemonUrl=...` from [pageUri] or falls back to [fallbackUrl].
Uri resolveWebDaemonBaseUri({
  required Uri pageUri,
  required String fallbackUrl,
}) {
  final Uri? queryOverride = parseValidDaemonUri(
    pageUri.queryParameters['daemonUrl'],
  );
  if (queryOverride != null) {
    return queryOverride;
  }
  return Uri.parse(fallbackUrl);
}

/// Resolves the daemon base URI from runtime overrides or compile-time defaults.
Uri resolveDaemonBaseUri({Uri? webPageUri, String? envDaemonUrl}) {
  return platform.resolvePlatformDaemonBaseUri(
    fallbackUrl: _compileTimeDaemonUrl,
    webPageUri: webPageUri,
    envDaemonUrl: envDaemonUrl,
  );
}
