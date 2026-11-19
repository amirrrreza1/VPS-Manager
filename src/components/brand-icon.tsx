import Image from "next/image";

/** Shares the favicon's vector source so the product mark stays consistent. */
export function BrandIcon({ size = 32, className }: { size?: number; className?: string }) {
  return <Image src="/icon.svg" alt="" width={size} height={size} className={className} unoptimized />;
}
