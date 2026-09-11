import Image from "next/image";

export default function Logo({
  size = 28,
  withWordmark = true,
  className = "",
}: {
  size?: number;
  withWordmark?: boolean;
  variant?: "white" | "blue";
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <Image
        src="/oathlock-logo.png"
        alt="M9R"
        width={size}
        height={size}
        className="shrink-0 object-contain"
        style={{ width: size, height: size }}
      />
      {withWordmark && (
        <span className="text-base font-semibold tracking-tight">M9R</span>
      )}
    </span>
  );
}
