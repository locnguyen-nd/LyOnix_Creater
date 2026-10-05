export function avatarDataUri(label: string, bg = "#161616", fg = "#F5F5F5"): string {
  const text = label.replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 2).toUpperCase() || "CH";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect fill="${bg}" width="96" height="96"/><text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" fill="${fg}" font-size="34" font-family="Inter,sans-serif">${text}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function imageThumbUri(title: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect fill="#1A1A1A" width="640" height="360"/><rect fill="#2A2A2A" x="40" y="40" width="560" height="280"/><text x="50%" y="50%" text-anchor="middle" fill="#F5F5F5" font-size="22" font-family="Inter,sans-serif">${title}</text><text x="50%" y="72%" text-anchor="middle" fill="#A3A3A3" font-size="14" font-family="Inter,sans-serif">9:16 preview</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
