import { describe, expect, it } from "vitest";
import validFixture from "../ws-valid.fixture.json" with { type: "json" };
import invalidFixture from "../ws-invalid.fixture.json" with { type: "json" };
import {
  createAckMessage,
  createErrorMessage,
  createHelloMessage,
  createSnapshotMessage,
  createSubmitMessage,
  parseClientMessage,
  parseDaemonMessage,
} from "../index.ts";

describe("WebSocket wire protocol contract", () => {
  it("parses and round-trips every valid client fixture", () => {
    expect(parseClientMessage(validFixture.client.hello)).toEqual(
      createHelloMessage({
        client: { name: "alfred-client", version: "1.0.0", platform: "web" },
      }),
    );
    expect(parseClientMessage(validFixture.client.helloMinimal)).toEqual(createHelloMessage());
    expect(parseClientMessage(validFixture.client.submit)).toEqual(
      createSubmitMessage({
        threadId: "main",
        requestId: "req-001",
        text: "What is on my schedule today?",
      }),
    );
  });

  it("parses and round-trips every valid daemon fixture", () => {
    expect(parseDaemonMessage(validFixture.daemon.snapshotEmpty)).toEqual(
      createSnapshotMessage({
        seq: 0,
        thread: {
          id: "main",
          agentName: "Alfred",
          status: "idle",
          messages: [],
        },
      }),
    );
    expect(parseDaemonMessage(validFixture.daemon.snapshotWithMessages)).toEqual(
      validFixture.daemon.snapshotWithMessages,
    );
    expect(parseDaemonMessage(validFixture.daemon.snapshotStreaming)).toEqual(
      validFixture.daemon.snapshotStreaming,
    );
    expect(parseDaemonMessage(validFixture.daemon.ack)).toEqual(
      createAckMessage({
        threadId: "main",
        requestId: "req-001",
        submissionId: "sub-001",
      }),
    );
    expect(parseDaemonMessage(validFixture.daemon.ackDeduplicated)).toEqual(
      createAckMessage({
        threadId: "main",
        requestId: "req-001",
        submissionId: "sub-001",
        deduplicated: true,
      }),
    );
    expect(parseDaemonMessage(validFixture.daemon.errorHandshake)).toEqual(
      createErrorMessage({
        code: "handshake_required",
        message: "Send hello before any other message.",
      }),
    );
    expect(parseDaemonMessage(validFixture.daemon.errorUnsupportedVersion)).toEqual(
      createErrorMessage({
        code: "unsupported_protocol_version",
        message: "Unsupported protocol version 99; expected 1.",
        protocolVersion: 99,
        expectedProtocolVersion: 1,
      }),
    );
    expect(parseDaemonMessage(validFixture.daemon.errorSubmit)).toEqual(
      createErrorMessage({
        code: "unknown_thread",
        message: "Thread not found.",
        threadId: "missing",
        requestId: "req-404",
      }),
    );
  });

  it("rejects every invalid client fixture", () => {
    for (const testCase of invalidFixture.client) {
      expect(() => parseClientMessage(testCase.payload), testCase.name).toThrow();
    }
  });

  it("rejects every invalid daemon fixture", () => {
    for (const testCase of invalidFixture.daemon) {
      expect(() => parseDaemonMessage(testCase.payload), testCase.name).toThrow();
    }
  });
});
