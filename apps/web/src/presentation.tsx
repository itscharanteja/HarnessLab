import { Alert, Badge, Code, Group, Loader, Text } from "@mantine/core";
import type { ExperimentSummary } from "@harnesslab/schemas/types";
import Link from "next/link";

export const human = (text: string) =>
  text.replaceAll("_", " ").replaceAll("-", " ");
export const shortHash = (hash: string) => hash.slice(0, 12);
export const time = (value: string) =>
  new Date(value).toISOString().replace("T", " ").slice(0, 16) + " UTC";
export const pct = (value: string | null) =>
  value === null ? "Unavailable" : `${(Number(value) * 100).toFixed(1)}%`;
export const decimal = (value: string | null) =>
  value === null
    ? "Unavailable"
    : Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 });

export function Mode({ mode }: { mode: ExperimentSummary["mode"] }) {
  return mode === "fixture" ? (
    <Group gap="xs">
      <Badge color="teal" variant="light">
        Fixture model
      </Badge>
      <Badge color="gray" variant="outline">
        Development only
      </Badge>
    </Group>
  ) : (
    <Badge color="blue" variant="light">
      Live model
    </Badge>
  );
}

export function Status({ status }: { status: string }) {
  const color =
    status === "completed" || status === "passed"
      ? "teal"
      : status === "failed" || status === "rejected"
        ? "red"
        : status === "running" || status === "queued"
          ? "blue"
          : "gray";
  return (
    <Badge color={color} variant="light">
      {human(status)}
    </Badge>
  );
}

export function Pending({ label = "Loading" }: { label?: string }) {
  return (
    <Group role="status" className="empty-state">
      <Loader size="xs" />
      <Text size="sm">{label}…</Text>
    </Group>
  );
}

export function Problem({ message }: { message: string }) {
  return (
    <Alert
      role="alert"
      color="red"
      variant="light"
      title="Unable to complete the request"
    >
      {message}
    </Alert>
  );
}

export function HarnessLink({ hash }: { hash: string }) {
  return (
    <Link href={`/harnesses/${hash}`} title={hash}>
      <Code>{shortHash(hash)}</Code>
    </Link>
  );
}
