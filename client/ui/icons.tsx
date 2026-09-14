import type { CSSProperties, ReactNode } from "react";

export type PixelIconName =
  | "app"
  | "inspect"
  | "feed"
  | "wash"
  | "play"
  | "pet"
  | "tree"
  | "kill"
  | "build"
  | "pause"
  | "run"
  | "terminal"
  | "sound"
  | "mute"
  | "files"
  | "help";

/** Original small raster-style UI drawings; no episode or inherited sprite assets. */
export function PixelIcon({
  name,
  size = 22,
  style,
}: {
  name: PixelIconName;
  size?: number;
  style?: CSSProperties;
}) {
  const drawings: Record<PixelIconName, ReactNode> = {
    app: (
      <>
        <path fill="#ffff00" d="M3 3h6v6H3zm12 0h6v6h-6zM3 15h6v6H3zm12 0h6v6h-6z" />
        <path fill="#fff" d="M10 6h4v12h-4zM6 10h12v4H6z" />
      </>
    ),
    inspect: (
      <>
        <path fill="#000" d="M5 2h2v2h2v2h2v2h2v2h2v2h2v2h-6v2h2v3h2v3h-4v-3H9v-3H7v3H5z" />
        <path fill="#fff" d="M7 6h2v2h2v2h2v2H9v3H7z" />
      </>
    ),
    feed: (
      <>
        <path fill="#482706" d="M11 2h3v5h-3z" />
        <path fill="#006000" d="M14 3h6v3h-6z" />
        <path fill="#580000" d="M5 7h14v2h2v9h-2v3H6v-2H3V9h2z" />
        <path fill="#ee2020" d="M6 8h12v2h2v7h-3v3H7v-3H4v-7h2z" />
        <path fill="#ffaaaa" d="M7 9h4v3H7z" />
        <path fill="#bf0000" d="M16 12h3v5h-3v2h-4v-2h4z" />
      </>
    ),
    wash: (
      <>
        <path fill="#003064" d="M11 2h2v3h2v3h2v3h2v7h-2v3H7v-3H5v-7h2V8h2V5h2z" />
        <path fill="#00aaff" d="M11 6h2v3h2v3h2v5h-3v3H8v-3H7v-5h2V9h2z" />
        <path fill="#c8f4ff" d="M9 10h2v7H9z" />
      </>
    ),
    play: (
      <>
        <path fill="#000" d="M8 2h8v2h4v4h2v8h-2v4h-4v2H8v-2H4v-4H2V8h2V4h4z" />
        <path fill="#fff" d="M8 4h8v2h4v10h-4v4H8v-4H4V8h4z" />
        <path fill="#f02020" d="M11 4h5v3h3v4h-6v9H9v-7H4V9h7z" />
        <path fill="#003cbc" d="M4 13h5v7H6v-4H4zm12 0h4v3h-4v4h-3v-5h3z" />
      </>
    ),
    pet: (
      <>
        <path fill="#000" d="M10 2h4v6h2V6h4v3h3v10h-3v3H8v-3H5v-3H2v-5h4v2h2V5h2z" />
        <path fill="#ffcc99" d="M11 3h2v10h2V9h2V8h2v6h2v4h-3v3H9v-3H6v-3H4v-3h1v2h4V6h2z" />
      </>
    ),
    tree: (
      <>
        <path fill="#603300" d="M10 13h5v10h-5z" />
        <path fill="#003900" d="M8 1h8v3h4v4h3v8h-4v3H5v-3H1V8h3V4h4z" />
        <path fill="#009300" d="M8 3h7v4h5v8h-5v3H6v-4H3V9h4z" />
        <path fill="#4bdf22" d="M8 4h6v3H8zM5 8h5v4H5z" />
      </>
    ),
    kill: (
      <>
        <path fill="#000" d="M7 2h13v8h-3v6h5v6H2v-7h5z" />
        <path fill="#656b79" d="M9 4h9v5h-3v8h5v3H4v-3h5z" />
        <path fill="#aaaebe" d="M10 4h7v2h-7zM5 17h6v2H5z" />
        <path fill="#ff2929" d="M1 3h2v3H1zm3 4h3v2H4zM2 10h2v2H2z" />
      </>
    ),
    build: (
      <>
        <path fill="#000" d="M4 3h14v6h-4v3h-2v9H8V10H4z" />
        <path fill="#808890" d="M5 4h11v4h-5v2H8V8H5z" />
        <path fill="#e3e7eb" d="M5 4h11v2H5z" />
        <path fill="#865500" d="M9 11h2v9H9z" />
      </>
    ),
    pause: <path fill="currentColor" d="M5 4h5v16H5zm9 0h5v16h-5z" />,
    run: <path fill="currentColor" d="M6 3h3v2h3v2h3v2h3v2h3v2h-3v2h-3v2h-3v2H9v2H6z" />,
    terminal: (
      <>
        <path fill="#000" d="M2 3h20v17H2z" />
        <path fill="#008000" d="M4 5h16v13H4z" />
        <path fill="#b8ffac" d="M6 7h2v2h2v2H8v2H6v-2h2V9H6zm7 6h5v2h-5z" />
      </>
    ),
    sound: (
      <>
        <path
          fill="#000"
          d="M2 9h5V6h3V3h3v18h-3v-3H7v-3H2zm14-3h2v3h2v6h-2v3h-2v-3h2V9h-2zm4-3h2v5h2v8h-2v5h-2v-5h2V8h-2z"
        />
      </>
    ),
    mute: (
      <>
        <path fill="#000" d="M2 9h5V6h3V3h3v18h-3v-3H7v-3H2z" />
        <path fill="#a00000" d="M16 7h2v3h2V7h2v3h-2v4h2v3h-2v-3h-2v3h-2v-3h2v-4h-2z" />
      </>
    ),
    files: (
      <>
        <path fill="#000" d="M3 2h16l3 3v17H2V2z" />
        <path fill="#202080" d="M4 4h14l2 2v14H4z" />
        <path fill="#c0c0c0" d="M6 3h10v7H6zM6 13h11v7H6z" />
        <path fill="#606060" d="M12 4h3v5h-3z" />
        <path fill="#fff" d="M8 15h7v1H8zm0 3h7v1H8z" />
      </>
    ),
    help: (
      <>
        <path
          fill="#000080"
          d="M7 2h10v2h3v7h-3v3h-3v3h-4v-5h3V9h3V6h-3V5H9v3H5V4h2zM10 19h4v4h-4z"
        />
      </>
    ),
  };
  return (
    <svg
      className="pixel-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
      style={style}
    >
      {drawings[name]}
    </svg>
  );
}
