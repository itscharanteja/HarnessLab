"use client";

import { Anchor, Code, Group, Stack, Text, Title } from "@mantine/core";
import type { HarnessDetail } from "@harnesslab/schemas/types";
import Link from "next/link";
import { useCallback } from "react";
import { api } from "./api";
import {
  HarnessLink,
  Mode,
  Pending,
  Problem,
  shortHash,
  Status,
} from "./presentation";
import { useToken } from "./shell";
import { useResource } from "./use-resource";

export function Harness({ hash }: { hash: string }) {
  const token = useToken();
  const load = useCallback(
    (signal: AbortSignal) =>
      api<HarnessDetail>(`harnesses/${hash}`, token, { signal }),
    [hash, token],
  );
  const result = useResource(hash, load);
  return (
    <Stack gap="lg">
      <Anchor component={Link} href="/">
        All experiments
      </Anchor>
      <div>
        <div className="eyebrow">Harness lineage</div>
        <h1 className="page-title">Version {shortHash(hash)}</h1>
        <Group>
          {result.value?.modes?.map((mode) => (
            <Mode key={mode} mode={mode} />
          ))}
        </Group>
      </div>
      {result.error && <Problem message={result.error} />}
      {!result.value && !result.error && (
        <Pending label="Loading harness version" />
      )}
      {result.value && (
        <>
          <section className="panel">
            <Group justify="space-between">
              <Title order={2}>Immutable configuration</Title>
              <Status
                status={
                  result.value.harness.active
                    ? "active baseline"
                    : "stored version"
                }
              />
            </Group>
            <Text className="wrap" size="sm" mt="sm">
              {hash}
            </Text>
            <Text size="sm" mt="sm">
              {result.value.harness.parent_hash ? (
                <>
                  Parent ·{" "}
                  <HarnessLink hash={result.value.harness.parent_hash} />
                </>
              ) : (
                "No visible parent version."
              )}
            </Text>
          </section>
          <section className="panel">
            <Title order={2}>Changes from parent</Title>
            {result.value.diff?.length ? (
              <ul>
                {result.value.diff.map((item) => (
                  <li key={item.path} className="wrap">
                    <Code>{item.path}</Code> → {JSON.stringify(item.value)}
                  </li>
                ))}
              </ul>
            ) : (
              <Text size="sm">No parent diff is available.</Text>
            )}
            <details>
              <summary>Full configuration</summary>
              <pre className="data-code">
                {JSON.stringify(result.value.harness.config, null, 2)}
              </pre>
            </details>
          </section>
        </>
      )}
    </Stack>
  );
}
