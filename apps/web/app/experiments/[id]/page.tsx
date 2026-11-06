import { Experiment } from "../../../src/experiment";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <Experiment id={id} />;
}
