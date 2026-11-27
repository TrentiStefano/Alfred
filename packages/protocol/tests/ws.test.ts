import { describe, expect, it } from "vitest";
import validFixture from "../ws-valid.fixture.json" with { type: "json" };
import invalidFixture from "../ws-invalid.fixture.json" with { type: "json" };
import {
  createAckMessage,
  createDeltaMessage,
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
    expect(parseDaemonMessage(validFixture.daemon.deltaTurnStartOwner)).toEqual(
      createDeltaMessage({
        threadId: "main",
        seq: 1,
        event: {
          kind: "turn_start",
          messageId: "entry-1",
          role: "owner",
          text: "Hello Alfred",
          requestId: "req-001",
          createdAt: "2026-11-27T12:00:00.000Z",
        },
      }),
    );
    expect(parseDaemonMessage(validFixture.daemon.deltaTurnStartAgent)).toEqual(
      createDeltaMessage({
        threadId: "main",
        seq: 3,
        event: {
          kind: "turn_start",
          messageId: "live-gen-1",
          role: "agent",
          createdAt: "2026-11-27T12:00:01.000Z",
        },
      }),
    );
    expect(parseDaemonMessage(validFixture.daemon.deltaTextDelta)).toEqual(
      createDeltaMessage({
        threadId: "main",
        seq: 4,
        event: {
          kind: "text_delta",
          messageId: "live-gen-1",
          delta: "Good day.",
        },
      }),
    );
    expect(parseDaemonMessage(validFixture.daemon.deltaTurnFinish)).toEqual(
      createDeltaMessage({
        threadId: "main",
        seq: 5,
        event: {
          kind: "turn_finish",
          messageId: "live-gen-1",
          status: "complete",
        },
      }),
    );
    expect(parseDaemonMessage(validFixture.daemon.deltaTurnError)).toEqual(
      createDeltaMessage({
        threadId: "main",
        seq: 6,
        event: {
          kind: "turn_error",
          messageId: "live-gen-2",
          status: "error",
          message: "Model request failed.",
        },
      }),
    );
    expect(parseDaemonMessage(validFixture.daemon.deltaTurnInterrupted)).toEqual(
      createDeltaMessage({
        threadId: "main",
        seq: 7,
        event: {
          kind: "turn_error",
          messageId: "live-gen-3",
          status: "interrupted",
          message: "Response interrupted.",
        },
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
