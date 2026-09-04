// The Robinhood app mark: the feather on the brand tile. Paths are the feather
// from Robinhood's own wordmark, scaled and placed to match their 152px icon
// (feather box 90x114 at y=19, tile radius 16). The tile is not decoration --
// the brand green is #CCFF00, which is invisible on the light theme as a bare
// glyph, and the tile is how Robinhood themselves render the mark.
export function RobinhoodIcon({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      className={className}
      height="152"
      style={style}
      viewBox="0 0 152 152"
      width="152"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>Robinhood</title>
      <rect fill="#CCFF00" height="152" rx="16" width="152" />
      <g fill="#110E08" transform="translate(29.77 19) scale(0.76239)">
        <path d="m73.96,33.73h-30.4c-1.1,0-2.03.44-2.8,1.4l-21.8,27c-3.2,4-4,7.7-4,13v27.6C7.86,122.63,3.36,136.13.06,148.33c-.2.78.1,1.2.8,1.2h3.3c.6,0,1.2-.3,1.4-.8C30.46,85.33,57.56,53.93,74.56,35.13c.7-.8.4-1.4-.6-1.4Z" />
        <path d="m74.86,2.63c-2.04.79-4,2.13-4.9,2.9-9,7.7-15,13.8-20.7,19.8-.7.7-.4,1.4.6,1.4h33.7c3.1,0,4.9,1.8,4.9,4.9v38c0,1,.8,1.3,1.4.4l20.3-26.5c3.3-4.3,4.3-5.6,5.2-11.6,1.2-8.8.5-22.3-4.8-27.9-4.7-5-25.9-5.2-35.7-1.4Z" />
        <path d="m79.96,41.33c-20.9,23.3-37.2,47.8-52.3,77.3-.38.74.1,1.4,1,1.1l31.2-9.6c3.52-1.08,5.5-2.5,7.2-5.3l13.9-22.9c.3-.6.4-1.3.4-1.8v-38.2c0-1-.7-1.4-1.4-.6Z" />
      </g>
    </svg>
  );
}
