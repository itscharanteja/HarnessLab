import "@mantine/core/styles.css";
import "./dashboard.css";

import {
  ColorSchemeScript,
  MantineProvider,
  mantineHtmlProps,
} from "@mantine/core";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DashboardShell } from "../src/shell";

export const metadata: Metadata = {
  title: "HarnessLab",
  description: "DataOps investigation experiments",
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" {...mantineHtmlProps}>
      <head>
        <ColorSchemeScript forceColorScheme="light" />
      </head>
      <body>
        <MantineProvider
          forceColorScheme="light"
          theme={{ primaryColor: "teal", fontFamily: "system-ui, sans-serif" }}
        >
          <DashboardShell>{children}</DashboardShell>
        </MantineProvider>
      </body>
    </html>
  );
}
