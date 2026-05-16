import React from "react";
import { Composition, registerRoot } from "remotion";
import { CockpitDemo } from "./Composition";

// 22 seconds @ 30 fps = 660 frames
const FPS = 30;
const DURATION = 22; // seconds
const DURATION_FRAMES = FPS * DURATION;

const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="CockpitDemo"
        component={CockpitDemo}
        durationInFrames={DURATION_FRAMES}
        fps={FPS}
        width={1920}
        height={1080}
      />
    </>
  );
};

// Remotion 4.x requires the entry file to call registerRoot. Without this
// call the CLI errors with "this file does not contain registerRoot".
registerRoot(RemotionRoot);
