"use client";

import { Button, Group, Modal, PasswordInput, SegmentedControl, Text } from "@mantine/core";
import Link from "next/link";
import { createContext, useContext, useState, type ReactNode } from "react";

const TokenContext = createContext("");
export const useToken = () => useContext(TokenContext);

export type ViewMode = "business" | "technical";
const ViewModeContext = createContext<ViewMode>("business");
export const useViewMode = () => useContext(ViewModeContext);

export function DashboardShell({ children }: { children: ReactNode }) {
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (typeof window !== "undefined") {
      const saved = window.localStorage.getItem("hl_view_mode");
      if (saved === "technical" || saved === "business") return saved;
    }
    return "business";
  });

  const updateViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("hl_view_mode", mode);
    }
  };

  const [token, setToken] = useState(() => {
    if (typeof window !== "undefined") {
      return (
        window.localStorage.getItem("hl_operator_token") ??
        "fixture-local-operator-token-00000001"
      );
    }
    return "fixture-local-operator-token-00000001";
  });
  const [entry, setEntry] = useState("");
  const [opened, setOpened] = useState(false);

  const updateToken = (newToken: string) => {
    setToken(newToken);
    if (typeof window !== "undefined") {
      if (newToken) {
        window.localStorage.setItem("hl_operator_token", newToken);
      } else {
        window.localStorage.removeItem("hl_operator_token");
      }
    }
  };
  return (
    <ViewModeContext.Provider value={viewMode}>
      <TokenContext.Provider value={token}>
        <header className="topbar">
          <div className="frame topbar-inner">
            <Link className="wordmark" href="/">
              <span className="mark" aria-hidden="true">
                HL
              </span>
              HarnessLab
            </Link>
            <Group gap="md">
              <SegmentedControl
                size="xs"
                radius="xl"
                value={viewMode}
                onChange={(val) => updateViewMode(val as ViewMode)}
                data={[
                  { label: "👔 Business View", value: "business" },
                  { label: "🛠️ Technical View", value: "technical" },
                ]}
              />
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
              updateToken(entry.trim());
              setEntry("");
              setOpened(false);
            }}
          >
            <PasswordInput
              label="Operator access token"
              value={entry}
              placeholder="fixture-local-operator-token-00000001"
              onChange={(event) => setEntry(event.currentTarget.value)}
              autoComplete="off"
              description="Default local operator token is fixture-local-operator-token-00000001"
            />
            <Group justify="space-between" mt="md">
              <Group gap="xs">
                <Button
                  type="button"
                  variant="subtle"
                  color="gray"
                  onClick={() => {
                    updateToken("");
                    setEntry("");
                    setOpened(false);
                  }}
                >
                  Clear token
                </Button>
                <Button
                  type="button"
                  variant="light"
                  color="teal"
                  onClick={() => {
                    updateToken("fixture-local-operator-token-00000001");
                    setEntry("");
                    setOpened(false);
                  }}
                >
                  Use default local token
                </Button>
              </Group>
              <Button type="submit" disabled={!entry.trim()}>
                Use token
              </Button>
            </Group>
          </form>
        </Modal>
      </TokenContext.Provider>
    </ViewModeContext.Provider>
  );
}
