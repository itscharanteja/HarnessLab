import { Badge, Container, Stack, Text, Title } from "@mantine/core";

export default function Home() {
  return (
    <Container component="main" size="sm" py="xl">
      <Stack align="flex-start">
        <Badge variant="light">Fixture mode</Badge>
        <Title>HarnessLab</Title>
        <Text>
          DataOps investigations, tool evidence and harness comparisons.
        </Text>
        <Text c="dimmed">
          Experiment history will appear here when the fixture workflow is
          available.
        </Text>
      </Stack>
    </Container>
  );
}
