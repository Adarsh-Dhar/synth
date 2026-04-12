"use client";

import dynamic from "next/dynamic";

const WebContainerBotRunner = dynamic(
  () => import("@/components/webcontainer-bot-runner").then((mod) => mod.WebContainerBotRunner),
  { ssr: false }
);

export default function WebcontainerBotRunnerClient() {
  return <WebContainerBotRunner />;
}