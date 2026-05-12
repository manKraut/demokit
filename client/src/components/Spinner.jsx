export function Spinner({ size = 16, className = '' }) {
  const px = `${size}px`;
  return (
    <span
      aria-label="loading"
      role="status"
      className={`inline-block animate-spin rounded-full border-2 border-current border-r-transparent align-[-2px] ${className}`}
      style={{ width: px, height: px }}
    />
  );
}
