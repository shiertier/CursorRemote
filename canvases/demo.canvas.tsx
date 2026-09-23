/**
 * Demo canvas for the CursorRemote right-hand panel.
 * Imports only from `cursor/canvas` so the same file renders in the Cursor IDE.
 * The relay aliases that module to @thisismydesign/cursor-canvas-web at bundle time.
 */
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Code,
  Grid,
  H1,
  H2,
  LineChart,
  Pill,
  Row,
  Stack,
  Stat,
  Text,
  useCanvasState,
  useHostTheme,
} from 'cursor/canvas';

export default function CursorRemoteCanvasDemo() {
  const theme = useHostTheme();
  const [checks, setChecks] = useCanvasState('remote.checks', 3);

  return (
    <Stack gap={16} style={{ padding: 20 }}>
      <Row align="center" gap={8}>
        <H1>CursorRemote canvas</H1>
        <Pill tone="success" active size="sm">live</Pill>
      </Row>
      <Text tone="secondary">
        This panel compiles a <Code>.canvas.tsx</Code> file and mounts it with the
        Mantine-backed cursor canvas shim. Chat stays on the left.
      </Text>
      <Text tone="tertiary" size="small">Host theme: {theme.kind}</Text>
      <Grid columns={3} gap={12}>
        <Stat value="2" label="Columns" tone="info" />
        <Stat value={String(checks)} label="Checks" tone="success" />
        <Stat value="1" label="Shim" />
      </Grid>
      <Card>
        <CardHeader>Split view</CardHeader>
        <CardBody>
          <Text>
            Open this file from the Canvas menu, or open a matching tab in Cursor
            while the relay is connected over CDP.
          </Text>
        </CardBody>
      </Card>
      <H2>Approvals this week</H2>
      <LineChart
        height={180}
        categories={['Mon', 'Tue', 'Wed', 'Thu', 'Fri']}
        series={[{ name: 'Approvals', data: [2, 4, 3, 6, 5], tone: 'info' }]}
      />
      <Callout tone="info" title="Add your own">
        Drop another .canvas.tsx into the canvases folder, or set CANVAS_DIRS to
        the folders you want the relay to scan.
      </Callout>
      <Row gap={8}>
        <Button variant="primary" onClick={() => setChecks((n) => n + 1)}>Add check</Button>
        <Button variant="secondary" onClick={() => setChecks(3)}>Reset</Button>
      </Row>
    </Stack>
  );
}
