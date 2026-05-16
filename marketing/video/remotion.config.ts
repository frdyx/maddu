import { Config } from "@remotion/cli/config";

// Output at 1080p with H.264 + AAC for broad compatibility.
// Concurrency stays at 1 by default so a render works on any laptop without
// running out of memory; bump via the --concurrency flag if you have cores.
Config.setVideoImageFormat("png");
Config.setPixelFormat("yuv420p");
Config.setCodec("h264");
Config.setColorSpace("bt709");

export {};
