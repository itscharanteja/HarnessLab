"use client";

import { Button, Group, Modal, PasswordInput, Text } from "@mantine/core";
import Link from "next/link";
import { createContext, useContext, useState, type ReactNode } from "react";

const TokenContext = createContext("");
export const useToken = () => useContext(TokenContext);

export function DashboardShell({ children }: { children: ReactNode }) {
  const [token, setToken] = useState("");
  const [entry, setEntry] = useState("");
  const [opened, setOpened] = useState(false);
  return (
    <TokenContext.Provider value={token}>
      <header className="topbar">
        <div className="frame topbar-inner">
          <Link className="wordmark" href="/">
            <span className="mark" aria-hidden="true">
              HL
            </span>
            HarnessLab
          </Link>
          <Group gap="lg">
            <Link href="/" className="top-link">
              Experiments
            </Link>
            <Button
              variant="subtle"
              color="gray"
              size="compact-sm"
              onClick={() => {
                setEntry("");
                setOpened(true);
              }}
            >
              {token ? "Operator session" : "Operator access"}
            </Button>
          </Group>
        </div>
      </header>
      <main className="frame main-content" id="main-content">
        {children}
      </main>
      <footer className="frame footer">
        <Text size="xs" c="dimmed">
          HarnessLab · Synthetic DataOps evaluation
        </Text>
        <Text size="xs" c="dimmed">
          Traces, comparisons, and review history
        </Text>
      </footer>
      <Modal
        title="Operator access"
        opened={opened}
        onClose={() => setOpened(false)}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setToken(entry.trim());
            setEntry("");
            setOpened(false);
          }}
        >
          <PasswordInput
            label="Operator access token"
            value={entry}
            onChange={(event) => setEntry(event.currentTarget.value)}
            autoComplete="off"
            description="The token stays in this browser tab for this session."
          />
          <Group justify="space-between" mt="md">
            <Button
              type="button"
              variant="subtle"
              color="gray"
              onClick={() => {
                setToken("");
                setEntry("");
                setOpened(false);
              }}
            >
              Clear token
            </Button>
            <Button type="submit" disabled={!entry.trim()}>
              Use token
            </Button>
          </Group>
        </form>
      </Modal>
    </TokenContext.Provider>
  );
}
