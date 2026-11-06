import { Harness } from "../../../src/harness";

export default async function Page({
  params,
}: {
  params: Promise<{ hash: string }>;
}) {
  const { hash } = await params;
  return <Harness hash={hash} />;
}
