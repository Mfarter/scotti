// The three public H2 spins, settled live on devnet against real Switchboard
// randomness (see README Devnet). The Fair page verifies these in-browser.
import type { SpinRef } from "./verify.ts";

export interface Artifact extends SpinRef {
  reels: string[];
  tier: string;
  payout: string;
  commitSig: string;
}

export const H2_ARTIFACTS: Artifact[] = [
  {
    machine: "9Ns1oYdSyqxYMfiRVSoTRLtuEGg6GdkSGkhCWapXsfi1",
    reels: ["BAR", "BELL", "CHERRY"], tier: "shallow",
    wager: "59410", payout: "50108", kBp: "10543", tierIsDeep: false, randSeedSlot: "474012263",
    randomnessAccount: "4kRfWqAHukyGCGejFtx8KLGwCyu31VpKDK28qLpnT2X8",
    commitSig: "2YQ1LbmuHKB5FCsncF8TV5G7R6NA5pdue3kH63fssxmJB1Zrj8j3HVeLJcArvjL1dBnkNwSPZBZoqXm962ARHoF1",
    settleSig: "2pxdF6FNLw1H9po6tcUs6REDT6LWifVPDxcD4MTcGvFL6jAJ7tKRYji48WPe65eBPvGP17abbFVHzeZvtf1owP3d",
  },
  {
    machine: "9Ns1oYdSyqxYMfiRVSoTRLtuEGg6GdkSGkhCWapXsfi1",
    reels: ["BLANK", "BAR", "BAR"], tier: "shallow",
    wager: "94994", payout: "0", kBp: "10527", tierIsDeep: false, randSeedSlot: "474012503",
    randomnessAccount: "D33m6ABsbdSYtdgQ3idA6NBTbAKZsZ1rK95AJYTekaa3",
    commitSig: "53Aes8NuNBNuvdfh261Zo5cNuWFnyyuPbZdpV41EPpdGDqYYagYSfEuKjdFDAE8e81nGSV8Bm7QWdNXGVrsyyC8f",
    settleSig: "2FMmYdbYNCehjsfoSka53cvAzBWyK7uFcwZ56m3T1Yw4KpqVqRwGVkYTtVShsTrUvNjNLQciwsZvKBDZbDgHR1XT",
  },
  {
    machine: "9Ns1oYdSyqxYMfiRVSoTRLtuEGg6GdkSGkhCWapXsfi1",
    reels: ["BELL", "BELL", "BELL"], tier: "shallow",
    wager: "95003", payout: "1200115", kBp: "10527", tierIsDeep: false, randSeedSlot: "474012727",
    randomnessAccount: "88NGNjCY2ZbbBfvQyWJfo5r2WJyK3xXtCzURDo5uNDVC",
    commitSig: "2V6NUmiCmzbdnr3ZTPuaCy223firsVXCmfV1R6Bf9fFH5Siu6iyRu4xbCtD68DQFoZUEFiTaT8kkTsKZ75bB6Ar9",
    settleSig: "3PN2YBiPYHG76Uc6J4gzqbn7PJn5M9BLXZ1A89kwBZvEuM5DVAkxwRvBwCfZmag6wNfpykeBN9XDFRiYMF1v8jQ6",
  },
];
