import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

export function FreePlanIcon(props: IconProps): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      viewBox="0 0 318 500"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M317.77 204.279H226.98V295.069H317.77V204.279Z"
        fill="currentColor"
        opacity="0.45"
      />
    </svg>
  );
}

export function ProPlanIcon(props: IconProps): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      viewBox="0 0 318 500"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M204.28 90.79V0H113.49V90.79C113.456 120.879 101.488 149.725 80.2115 171.002C58.9355 192.278 30.0889 204.246 0 204.28V295.07C30.0889 295.104 58.9355 307.072 80.2115 328.348C101.488 349.625 113.456 378.471 113.49 408.56V499.35H204.28V408.56C204.28 378.075 197.445 347.977 184.279 320.482C171.113 292.987 151.95 268.793 128.2 249.68C151.948 230.563 171.109 206.367 184.275 178.871C197.441 151.374 204.277 121.276 204.28 90.79Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function BusinessPlanIcon(props: IconProps): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      viewBox="0 0 318 500"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M317.77 204.279H226.98V295.069H317.77V204.279Z"
        fill="currentColor"
      />
      <path
        d="M204.28 90.79V0H113.49V90.79C113.456 120.879 101.488 149.725 80.2115 171.002C58.9355 192.278 30.0889 204.246 0 204.28V295.07C30.0889 295.104 58.9355 307.072 80.2115 328.348C101.488 349.625 113.456 378.471 113.49 408.56V499.35H204.28V408.56C204.28 378.075 197.445 347.977 184.279 320.482C171.113 292.987 151.95 268.793 128.2 249.68C151.948 230.563 171.109 206.367 184.275 178.871C197.441 151.374 204.277 121.276 204.28 90.79Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function EnterprisePlanIcon(props: IconProps): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      viewBox="-2 0 413 500"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path d="M0 204.279H90.79V295.069H0V204.279Z" fill="currentColor" />
      <path
        d="M408.56 204.279H317.77V295.069H408.56V204.279Z"
        fill="currentColor"
      />
      <path
        d="M295.07 90.79V0H204.28V90.79C204.246 120.879 192.278 149.725 171.002 171.002C149.725 192.278 120.879 204.246 90.79 204.28V295.07C120.879 295.104 149.725 307.072 171.002 328.348C192.278 349.625 204.246 378.471 204.28 408.56V499.35H295.07V408.56C295.07 378.075 288.235 347.977 275.069 320.482C261.903 292.987 242.74 268.793 218.99 249.68C242.738 230.563 261.899 206.367 275.065 178.871C288.231 151.374 295.067 121.276 295.07 90.79Z"
        fill="currentColor"
      />
    </svg>
  );
}
