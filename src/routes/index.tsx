import { createFileRoute } from "@tanstack/react-router";
import { TiltWell } from "@/components/tilt-well";

export const Route = createFileRoute("/")({
  component: TiltWell,
});
