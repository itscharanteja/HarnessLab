import { Comparison } from "../../../../src/comparison";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ run?: string | string[]; event?: string | string[] }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  return (
    <Comparison
      id={id}
      runId={typeof query.run === "string" ? query.run : undefined}
      event={
        typeof query.event === "string" && /^\d{1,5}$/.test(query.event)
          ? Number(query.event)
          : undefined
      }
    />
  );
}
