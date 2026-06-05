import crypto from "node:crypto";

const SLACK_VERSION = "v0";
const MAX_SIGNATURE_AGE_SECONDS = 60 * 5;

export function createSlackSignature({ signingSecret, timestamp, rawBody }) {
  const base = `${SLACK_VERSION}:${timestamp}:${rawBody}`;
  const digest = crypto
    .createHmac("sha256", signingSecret)
    .update(base, "utf8")
    .digest("hex");

  return `${SLACK_VERSION}=${digest}`;
}

export function isFreshSlackTimestamp(timestamp, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!timestamp || !/^\d+$/.test(timestamp)) {
    return false;
  }

  return Math.abs(nowSeconds - Number(timestamp)) <= MAX_SIGNATURE_AGE_SECONDS;
}

export function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(left ?? "", "utf8");
  const rightBuffer = Buffer.from(right ?? "", "utf8");
  const length = Math.max(leftBuffer.length, rightBuffer.length);
  const paddedLeft = Buffer.alloc(length);
  const paddedRight = Buffer.alloc(length);

  leftBuffer.copy(paddedLeft);
  rightBuffer.copy(paddedRight);

  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(paddedLeft, paddedRight)
  );
}

export function verifySlackRequestSignature({
  signingSecret,
  rawBody,
  timestamp,
  signature,
  nowSeconds
}) {
  if (!signingSecret || !rawBody || !timestamp || !signature) {
    return false;
  }

  if (!isFreshSlackTimestamp(timestamp, nowSeconds)) {
    return false;
  }

  const expected = createSlackSignature({
    signingSecret,
    timestamp,
    rawBody
  });

  return timingSafeStringEqual(expected, signature);
}
