/** @type {import("next").NextConfig} */
const nextConfig = {
  // ffmpeg-static exports `path.join(__dirname, "ffmpeg")`. Bundled, that
  // __dirname is a .next/server chunk directory and the path points at
  // nothing. Kept external, it is required from node_modules at runtime and
  // resolves to the real binary.
  serverExternalPackages: ["ffmpeg-static"],

  // The binary is a file the package names by path, never `require`s, so the
  // tracer cannot see it. Without this it is missing from the deployed
  // function and every segment rejoin fails with ENOENT.
  //
  // Only /review runs ffmpeg (adding a word, removing a segment). The glob
  // covers both `ffmpeg` (Linux, on Vercel) and `ffmpeg.exe` (Windows, local).
  outputFileTracingIncludes: {
    "/review": ["./node_modules/ffmpeg-static/ffmpeg*"],
  },
};

export default nextConfig;
