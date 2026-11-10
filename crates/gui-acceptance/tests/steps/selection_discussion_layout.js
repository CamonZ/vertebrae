// Executed by WebDriver in the Docker webview; returns measured evidence.
const [theme, width, expectedPending] = arguments;
const isLightTheme = document.documentElement.classList.contains("light");
const themeApplied = isLightTheme === (theme === "light");

const thread = document.querySelector('[data-testid="selection-mini-thread"]');

thread.style.width = `${width}px`;
thread.style.maxWidth = "none";
thread.scrollIntoView({
  block: "center",
  inline: "center",
  behavior: "instant",
});

const threadStyle = getComputedStyle(thread);
const threadBackground = threadStyle.backgroundColor;
const messages = thread.querySelector(".selection-mini-messages");

messages.scrollTop = messages.scrollHeight;

const bounds = messages.getBoundingClientRect();
const messageAreaRight = bounds.left + messages.clientWidth;

const rgb = (color) => {
  const components = color.match(/[\d.]+/g);
  const channels = components.slice(0, 3);

  return channels.map(Number);
};

const luminance = (color) => {
  const channels = rgb(color);
  const linearChannels = channels.map((value) => {
    const normalized = value / 255;

    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });

  return linearChannels.reduce(
    (sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index],
    0,
  );
};

const contrast = (foreground, background) => {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);

  return (lighter + 0.05) / (darker + 0.05);
};

// Rows come from the main chat's Thread renderer; they must stay legible and
// inside the inline card at every width.
const userMessages = [...messages.querySelectorAll(".evrow--user")];
const bubbles = userMessages.map((message) => {
  const text = message.querySelector(".ev-text");
  const style = getComputedStyle(text);
  const textContrast = contrast(style.color, threadBackground);

  return {
    inside: message.getBoundingClientRect().right <= messageAreaRight + 1,
    wraps: text.scrollWidth <= text.clientWidth + 1,
    contrast: textContrast,
    background: style.color,
  };
});

const assistantMessages = [...messages.querySelectorAll(".evrow--agent")];
const assistants = assistantMessages.map((message) => {
  const rect = message.getBoundingClientRect();
  const inside =
    rect.left >= bounds.left - 1 && rect.right <= messageAreaRight + 1;
  const markdown = message.querySelector("strong, ul");

  return inside && !!markdown;
});

const alert = thread.querySelector('[role="alert"]');
let errorContrast = true;

if (alert) {
  const alertStyle = getComputedStyle(alert);
  const textContrast = contrast(alertStyle.color, threadBackground);

  errorContrast = textContrast >= 4.5;
}

const indicatorLabel = thread.querySelector(
  '[data-testid="thinking-indicator"] .text-sm',
);
let indicatorContrast = true;
let indicatorTypography = !expectedPending;

if (indicatorLabel) {
  const labelStyle = getComputedStyle(indicatorLabel);
  const backgroundStyle = getComputedStyle(indicatorLabel.parentElement);
  const textContrast = contrast(
    labelStyle.color,
    backgroundStyle.backgroundColor,
  );

  indicatorContrast = textContrast >= 4.5;

  const typographyProperties = [
    "fontFamily",
    "fontSize",
    "fontWeight",
    "fontStyle",
    "lineHeight",
    "letterSpacing",
  ];

  indicatorTypography = typographyProperties.every(
    (property) => labelStyle[property] === threadStyle[property],
  );
}

const labels = [
  ...thread.querySelectorAll(".selection-mini-speaker, .selection-mini-badge"),
];
const labelContrast = labels.every((node) => {
  const style = getComputedStyle(node);
  const textContrast = contrast(style.color, threadBackground);

  return textContrast >= 4.5;
});

const composer = thread.querySelector("textarea");
const composerStyle = getComputedStyle(composer);
const placeholderStyle = getComputedStyle(composer, "::placeholder");
const placeholderTextContrast = contrast(
  placeholderStyle.color,
  composerStyle.backgroundColor,
);
const placeholderContrast = placeholderTextContrast >= 4.5;

const indicator = thread.querySelector('[data-testid="thinking-indicator"]');
const pending = !!indicator;
let indicatorVisible = true;

if (indicator) {
  const rect = indicator.getBoundingClientRect();

  indicatorVisible =
    rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight;

  for (
    let parent = indicator.parentElement;
    parent && parent !== document.body;
    parent = parent.parentElement
  ) {
    const parentStyle = getComputedStyle(parent);
    const clipsContent = /(auto|hidden|scroll|clip)/.test(
      parentStyle.overflowY,
    );

    if (clipsContent) {
      const clip = parent.getBoundingClientRect();

      indicatorVisible &&= rect.top >= clip.top && rect.bottom <= clip.bottom;
    }
  }
}

const noOverflow =
  thread.scrollWidth <= thread.clientWidth + 1 &&
  messages.scrollWidth <= messages.clientWidth + 1;
const pendingMatches =
  expectedPending === undefined || pending === expectedPending;
const bubblesPass = bubbles.every(
  (bubble) => bubble.inside && bubble.wraps && bubble.contrast >= 4.5,
);
const assistantsPass = assistants.every(Boolean);
const hasModelLabels = /Next reply:|Reply:/.test(thread.textContent);

const pass =
  themeApplied &&
  pendingMatches &&
  bubbles.length > 0 &&
  bubblesPass &&
  assistantsPass &&
  noOverflow &&
  labelContrast &&
  placeholderContrast &&
  errorContrast &&
  indicatorContrast &&
  indicatorTypography &&
  indicatorVisible &&
  !hasModelLabels;

return {
  pass,
  pending,
  themeApplied,
  historyScrollable: messages.scrollHeight > messages.clientHeight,
  background: bubbles[0]?.background,
  bubbles,
  assistants,
  noOverflow,
  labelContrast,
  placeholderContrast,
  errorContrast,
  indicatorContrast,
  indicatorTypography,
  indicatorVisible,
};
