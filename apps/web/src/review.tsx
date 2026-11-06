"use client";

import {
  Button,
  Group,
  Modal,
  Stack,
  Text,
  Textarea,
  Title,
} from "@mantine/core";
import type {
  EvaluationReport,
  ExperimentDetail,
  ReviewAccepted,
} from "@harnesslab/schemas/types";
import { useRef, useState } from "react";
import { api } from "./api";
import { Problem } from "./presentation";
import { useToken } from "./shell";

type Action = "promote" | "reject" | "rollback";
const verbs: Record<Action, string> = {
  promote: "Promote candidate",
  reject: "Reject candidate",
  rollback: "Roll back active harness",
};

export function Review({
  detail,
  report,
  refresh,
}: {
  detail: ExperimentDetail;
  report: EvaluationReport | undefined;
  refresh: (message: string) => void;
}) {
  const token = useToken();
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef({ fingerprint: "", key: "" });
  if (detail.active_revision === undefined || !detail.channel) return null;
  const revision = detail.active_revision;
  const channel = detail.channel;
  function select(next: Action) {
    setAction(next);
    setReason("");
    setError("");
  }
  async function confirm() {
    if (!action || !reason.trim() || (action !== "rollback" && !report)) return;
    const body = {
      expected_revision: revision,
      reason: reason.trim(),
      ...(action === "rollback"
        ? {}
        : {
            candidate_hash: report!.candidate_hash,
            report_digest: report!.report_digest,
          }),
    };
    const fingerprint = JSON.stringify([action, body]);
    if (request.current.fingerprint !== fingerprint)
      request.current = { fingerprint, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      const path =
        action === "rollback"
          ? `channels/${channel}/rollback`
          : `experiments/${detail.experiment.id}/${action}`;
      const result = await api<ReviewAccepted>(path, token, {
        body,
        key: request.current.key,
      });
      setAction(null);
      refresh(`Decision recorded · revision ${result.revision}`);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Review command failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <Title order={2} mb="sm">
        Operator review
      </Title>
      <Text size="sm" mb="sm">
        Channel {channel} · active revision {revision}
      </Text>
      <Group>
        <Button
          disabled={!report?.winner || detail.experiment.mode !== "live"}
          onClick={() => select("promote")}
        >
          Promote candidate
        </Button>
        <Button
          variant="light"
          disabled={!report}
          onClick={() => select("reject")}
        >
          Reject candidate
        </Button>
        <Button
          variant="outline"
          disabled={channel !== "production" || revision < 2}
          onClick={() => select("rollback")}
        >
          Roll back active harness
        </Button>
      </Group>
      <Modal
        opened={action !== null}
        title={action ? verbs[action] : "Review"}
        onClose={() => {
          if (!busy) setAction(null);
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void confirm();
          }}
        >
          <Stack>
            <Text size="sm">Expected active revision · {revision}</Text>
            {action !== "rollback" && report && (
              <div>
                <Text size="sm" className="wrap">
                  Candidate · {report.candidate_hash}
                </Text>
                <Text size="sm" className="wrap">
                  Report digest · {report.report_digest}
                </Text>
              </div>
            )}
            <Textarea
              label="Review reason"
              required
              maxLength={600}
              value={reason}
              onChange={(event) => setReason(event.currentTarget.value)}
            />
            {error && <Problem message={error} />}
            <Button type="submit" loading={busy} disabled={!reason.trim()}>
              Confirm {action}
            </Button>
          </Stack>
        </form>
      </Modal>
    </section>
  );
}
