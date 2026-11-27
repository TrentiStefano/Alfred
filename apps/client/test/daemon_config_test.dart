import 'package:alfred_client/daemon_config.dart';
import 'package:alfred_client/daemon_health.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'parseValidDaemonUri accepts valid http/https URIs and rejects others',
    () {
      expect(
        parseValidDaemonUri('http://127.0.0.1:4041'),
        Uri.parse('http://127.0.0.1:4041'),
      );
      expect(
        parseValidDaemonUri('https://alfred.example:8443'),
        Uri.parse('https://alfred.example:8443'),
      );
      expect(parseValidDaemonUri(null), isNull);
      expect(parseValidDaemonUri('   '), isNull);
      expect(parseValidDaemonUri('ws://127.0.0.1:4041'), isNull);
      expect(parseValidDaemonUri('javascript:alert(1)'), isNull);
      expect(parseValidDaemonUri('http://'), isNull);
    },
  );

  test(
    'resolveWebDaemonBaseUri overrides fallback when ?daemonUrl is valid',
    () {
      expect(
        resolveWebDaemonBaseUri(
          pageUri: Uri.parse(
            'http://127.0.0.1:8080/?daemonUrl=http%3A%2F%2F127.0.0.1%3A4055',
          ),
          fallbackUrl: kDefaultDaemonUrl,
        ),
        Uri.parse('http://127.0.0.1:4055'),
      );
      expect(
        resolveWebDaemonBaseUri(
          pageUri: Uri.parse('http://127.0.0.1:8080/?daemonUrl=ftp://bad'),
          fallbackUrl: kDefaultDaemonUrl,
        ),
        Uri.parse(kDefaultDaemonUrl),
      );
    },
  );

  test('resolveDaemonBaseUri uses IO env override when valid', () {
    expect(
      resolveDaemonBaseUri(envDaemonUrl: 'http://127.0.0.1:4999'),
      Uri.parse('http://127.0.0.1:4999'),
    );
    expect(
      resolveDaemonBaseUri(envDaemonUrl: ''),
      Uri.parse(kDefaultDaemonUrl),
    );
  });
}
