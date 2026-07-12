import type { ReactNode, SVGProps } from 'react';

export type LineIconName =
  | 'overview'
  | 'chat'
  | 'market'
  | 'play'
  | 'user'
  | 'gear'
  | 'tools'
  | 'book'
  | 'spark'
  | 'hook'
  | 'agents'
  | 'shield'
  | 'chart'
  | 'layers'
  | 'logout'
  | 'menu'
  | 'x'
  | 'bolt'
  | 'pin'
  | 'radio'
  | 'image'
  | 'copy'
  | 'trash'
  | 'sliders'
  | 'expand'
  | 'collapse'
  | 'chevronLeft'
  | 'chevronRight'
  | 'plus'
  | 'check'
  | 'download'
  | 'refresh'
  | 'pause';

const paths: Record<LineIconName, ReactNode> = {
  overview: (
    <>
      <path d="M4 13h6v7H4z" />
      <path d="M14 4h6v16h-6z" />
      <path d="M4 4h6v5H4z" />
    </>
  ),
  chat: <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.6 9.6 0 0 1-3.3-.6L3 21l1.4-4.2A8.3 8.3 0 0 1 3 11.5 8.5 8.5 0 0 1 12 3a8.5 8.5 0 0 1 9 8.5z" />,
  market: (
    <>
      <path d="M4 8h16l-1 12H5z" />
      <path d="M8 8V6a4 4 0 0 1 8 0v2" />
    </>
  ),
  play: <path d="M5 4l14 8-14 8z" />,
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2v3M12 19v3M22 12h-3M5 12H2M19 5l-2 2M7 17l-2 2M19 19l-2-2M7 7 5 5" />
    </>
  ),
  tools: <path d="M14.5 6.5a3.5 3.5 0 0 1-4.6 4.6L4 17v3h3l5.9-5.9a3.5 3.5 0 0 1 4.6-4.6l-2.5 2.5-2-2z" />,
  book: (
    <>
      <path d="M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2z" />
      <path d="M4 19a2 2 0 0 0 2 2h12" />
    </>
  ),
  spark: (
    <>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
      <path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" />
    </>
  ),
  hook: (
    <>
      <path d="M15 4a3 3 0 0 1 3 3v7a5 5 0 0 1-10 0v-1" />
      <circle cx="8" cy="16" r="2.5" />
    </>
  ),
  agents: (
    <>
      <circle cx="8" cy="8" r="3.2" />
      <circle cx="17" cy="16" r="3.2" />
      <path d="M10 10l5 4" />
    </>
  ),
  shield: <path d="M12 3l8 3v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6z" />,
  chart: (
    <>
      <path d="M4 20V4" />
      <path d="M4 20h16" />
      <path d="M8 16v-4M12 16V8M16 16v-7" />
    </>
  ),
  layers: (
    <>
      <path d="M12 3l9 5-9 5-9-5z" />
      <path d="M3 13l9 5 9-5M3 18l9 5 9-5" />
    </>
  ),
  logout: (
    <>
      <path d="M14 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4" />
      <path d="M10 12H3" />
      <path d="M6 8l-4 4 4 4" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  bolt: <path d="M13 2 4 14h7l-1 8 9-12h-7z" />,
  pin: (
    <>
      <path d="M12 17v5" />
      <path d="M8 3h8l-1 6 3 3v2H6v-2l3-3z" />
    </>
  ),
  radio: (
    <>
      <circle cx="12" cy="19" r="1.4" fill="currentColor" stroke="none" />
      <path d="M8.5 15.5a5 5 0 0 1 7 0" />
      <path d="M5.5 12.5a9 9 0 0 1 13 0" />
    </>
  ),
  image: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.4" />
      <path d="M20 15l-4.2-4.2a2 2 0 0 0-2.8 0L6 18" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V5a2 2 0 0 1 2-2h9a1 1 0 0 1 1 1v1" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M10 11v6M14 11v6" />
      <path d="M6 7l1 14h10l1-14" />
      <path d="M9 7V4h6v3" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7h7M15 7h5" />
      <circle cx="13" cy="7" r="2" />
      <path d="M4 17h5M13 17h7" />
      <circle cx="11" cy="17" r="2" />
    </>
  ),
  expand: (
    <>
      <path d="M8 4H4v4" />
      <path d="M4 4l6 6" />
      <path d="M16 4h4v4" />
      <path d="M20 4l-6 6" />
      <path d="M8 20H4v-4" />
      <path d="M4 20l6-6" />
      <path d="M16 20h4v-4" />
      <path d="M20 20l-6-6" />
    </>
  ),
  collapse: (
    <>
      <path d="M10 4v6H4" />
      <path d="M4 10l6-6" />
      <path d="M14 4v6h6" />
      <path d="M20 10l-6-6" />
      <path d="M10 20v-6H4" />
      <path d="M4 14l6 6" />
      <path d="M14 20v-6h6" />
      <path d="M20 14l-6 6" />
    </>
  ),
  chevronLeft: <path d="M15 18 9 12l6-6" />,
  chevronRight: <path d="m9 18 6-6-6-6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="m5 12 4 4L19 6" />,
  download: (
    <>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 7v5h-5" />
      <path d="M4 17v-5h5" />
      <path d="M7.5 7.5A7 7 0 0 1 19 10M5 14a7 7 0 0 0 11.5 2.5" />
    </>
  ),
  pause: (
    <>
      <path d="M8 5v14" />
      <path d="M16 5v14" />
    </>
  ),
};

export default function LineIcon({ name, ...props }: SVGProps<SVGSVGElement> & { name: LineIconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
