import { expect, test } from "vitest";
import {
  diagnosisRoster,
  matchedOrder,
} from "../../apps/dispatcher/src/trials.ts";

test("the development diagnosis is stratified, seeded and independent of input order", () => {
  const allocation = {
    schema_discovery: [10, 5],
    multi_step_analytics: [13, 7],
    data_inconsistencies: [10, 5],
    tool_failures: [10, 5],
    ambiguous_requests: [7, 3],
    efficiency: [10, 5],
  } as const;
  const roster = Object.entries(allocation).flatMap(([key, [count]]) =>
    Array.from({ length: count }, (_, i) => ({
      id: `${key}/${i}`,
      category: key as keyof typeof allocation,
    })),
  );
  const diagnosed = diagnosisRoster(roster, false);
  expect(diagnosed).toHaveLength(30);
  for (const [category, [, expected]] of Object.entries(allocation))
    expect(diagnosed.filter((task) => task.category === category)).toHaveLength(
      expected,
    );
  expect(diagnosisRoster([...roster].reverse(), false)).toEqual(diagnosed);
  expect(diagnosisRoster(roster, false, 3)).not.toEqual(diagnosed);
  expect(diagnosisRoster(roster, true)).toHaveLength(6);
});

test("each repeat retains every arm with a reproducible within-block order", () => {
  const arms = [{ hash: "a" }, { hash: "b" }, { hash: "c" }];
  const ordered = matchedOrder(arms, "validation-task", 3, 20251106);
  expect(new Set(ordered)).toEqual(new Set(arms));
  expect(
    matchedOrder([...arms].reverse(), "validation-task", 3, 20251106),
  ).toEqual(ordered);
});
