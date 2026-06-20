export function languageFromFilename(name = "") {
  const lowerName = name.toLowerCase();
  const extension = lowerName.includes(".") ? lowerName.split(".").pop() : lowerName;
  const map = {
    bash: "shell",
    bat: "shell",
    c: "c",
    cmd: "shell",
    conf: "ini",
    cpp: "cpp",
    cs: "csharp",
    css: "css",
    csv: "csv",
    dockerfile: "docker",
    go: "go",
    h: "c",
    hpp: "cpp",
    htm: "html",
    html: "html",
    ini: "ini",
    java: "java",
    js: "javascript",
    json: "json",
    jsonc: "json",
    jsx: "javascript",
    kt: "kotlin",
    kts: "kotlin",
    log: "log",
    mjs: "javascript",
    nfo: "xml",
    php: "php",
    ps1: "powershell",
    py: "python",
    rb: "ruby",
    rs: "rust",
    sh: "shell",
    sql: "sql",
    swift: "swift",
    toml: "toml",
    ts: "typescript",
    tsx: "typescript",
    txt: "text",
    vue: "html",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
  };
  if (lowerName === "dockerfile" || lowerName.endsWith(".dockerfile")) return "docker";
  return map[extension] || "text";
}

function keywordPattern(language) {
  const groups = {
    c: "auto|break|case|char|const|continue|default|do|double|else|enum|extern|float|for|goto|if|inline|int|long|register|return|short|signed|sizeof|static|struct|switch|typedef|union|unsigned|void|volatile|while",
    cpp: "alignas|alignof|and|auto|bool|break|case|catch|class|const|constexpr|continue|decltype|default|delete|do|double|else|enum|explicit|export|extern|false|float|for|friend|if|inline|int|long|namespace|new|nullptr|operator|private|protected|public|return|short|sizeof|static|struct|switch|template|this|throw|true|try|typedef|typename|using|virtual|void|while",
    csharp: "abstract|as|async|await|base|bool|break|case|catch|class|const|continue|decimal|default|delegate|do|double|else|enum|event|explicit|extern|false|finally|float|for|foreach|if|implicit|in|int|interface|internal|is|lock|namespace|new|null|object|out|override|private|protected|public|readonly|ref|return|sealed|static|string|struct|switch|this|throw|true|try|using|var|virtual|void|while",
    css: "align-items|background|border|box-shadow|color|content|display|flex|font|gap|grid|height|inset|justify-content|margin|max-width|min-height|overflow|padding|place-items|position|transform|transition|width|z-index",
    go: "break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var",
    java: "abstract|assert|boolean|break|case|catch|class|const|continue|default|do|double|else|enum|extends|false|final|finally|float|for|if|implements|import|instanceof|int|interface|long|new|null|package|private|protected|public|return|static|super|switch|this|throw|throws|true|try|void|while",
    javascript: "async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|false|finally|for|from|function|get|if|import|in|instanceof|let|new|null|of|return|set|static|super|switch|this|throw|true|try|typeof|undefined|var|void|while|yield",
    json: "true|false|null",
    kotlin: "as|break|class|continue|data|do|else|false|for|fun|if|import|in|interface|is|null|object|package|return|this|throw|true|try|typealias|val|var|when|while",
    php: "abstract|and|array|as|break|case|catch|class|clone|const|continue|declare|default|do|echo|else|elseif|endfor|endforeach|endif|endswitch|endwhile|extends|false|final|finally|fn|for|foreach|function|global|if|implements|include|interface|namespace|new|null|or|private|protected|public|require|return|static|switch|throw|trait|true|try|use|var|while|xor",
    powershell: "begin|break|catch|class|continue|data|do|dynamicparam|else|elseif|end|exit|filter|finally|for|foreach|from|function|if|in|param|process|return|switch|throw|trap|try|until|using|var|while",
    python: "and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield",
    ruby: "alias|and|begin|break|case|class|def|defined|do|else|elsif|end|ensure|false|for|if|in|module|next|nil|not|or|redo|rescue|retry|return|self|super|then|true|undef|unless|until|when|while|yield",
    rust: "as|async|await|break|const|continue|crate|dyn|else|enum|extern|false|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|true|type|unsafe|use|where|while",
    shell: "case|do|done|elif|else|esac|fi|for|function|if|in|local|then|until|while",
    sql: "alter|and|as|between|by|case|create|delete|desc|distinct|drop|else|end|exists|from|group|having|in|insert|into|is|join|left|like|limit|not|null|on|or|order|outer|right|select|set|table|then|union|update|values|when|where",
    swift: "actor|as|associatedtype|async|await|break|case|catch|class|continue|defer|do|else|enum|extension|false|for|func|guard|if|import|in|init|let|nil|protocol|return|self|static|struct|switch|throw|true|try|typealias|var|where|while",
    typescript: "abstract|any|as|async|await|boolean|break|case|catch|class|const|continue|declare|default|delete|do|else|enum|export|extends|false|finally|for|from|function|get|if|implements|import|in|infer|instanceof|interface|keyof|let|module|namespace|never|new|null|number|of|private|protected|public|readonly|return|set|static|string|super|switch|this|throw|true|try|type|typeof|undefined|unknown|var|void|while|yield",
  };
  return groups[language] || groups.javascript;
}

export function highlightCode(rawCode, language = "text", escapeHtml) {
  const code = String(rawCode || "");
  if (["text", "log", "csv"].includes(language)) return escapeHtml(code);
  if (language === "html" || language === "xml") {
    return escapeHtml(code).replace(/(&lt;\/?)([\w:-]+)([^&]*?)(\/?&gt;)/g, (_match, open, tag, attrs, close) => {
      const coloredAttrs = attrs.replace(/([\w:-]+)(=)(&quot;.*?&quot;|'.*?'|[^\s&]+)/g, '<span class="tok-attr">$1</span>$2<span class="tok-string">$3</span>');
      return `${open}<span class="tok-keyword">${tag}</span>${coloredAttrs}${close}`;
    });
  }

  const commentPrefix = ["python", "ruby", "shell", "powershell", "yaml", "toml", "ini", "docker"].includes(language) ? "#.*" : "\\/\\/.*";
  const commentBlock = ["css", "javascript", "typescript", "java", "c", "cpp", "csharp", "go", "rust", "swift", "php"].includes(language) ? "|\\/\\*[\\s\\S]*?\\*\\/" : "";
  const tokenRegex = new RegExp(`(${commentPrefix}${commentBlock}|"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\`(?:\\\\.|[^\`\\\\])*\`)`, "g");
  const keywords = new RegExp(`\\b(${keywordPattern(language)})\\b`, "g");
  let result = "";
  let lastIndex = 0;

  const highlightPlain = (part) =>
    escapeHtml(part)
      .replace(/\b(0x[\da-fA-F]+|\d+(?:\.\d+)?)\b/g, '<span class="tok-number">$1</span>')
      .replace(keywords, '<span class="tok-keyword">$1</span>');

  for (const match of code.matchAll(tokenRegex)) {
    result += highlightPlain(code.slice(lastIndex, match.index));
    const token = match[0];
    const isComment = token.startsWith("//") || token.startsWith("/*") || token.startsWith("#");
    result += `<span class="${isComment ? "tok-comment" : "tok-string"}">${escapeHtml(token)}</span>`;
    lastIndex = match.index + token.length;
  }
  result += highlightPlain(code.slice(lastIndex));
  return result;
}

export function renderCodeBlock(code, language, className = "", escapeHtml) {
  const lang = language || "text";
  const classes = ["code-preview", className, `language-${lang}`].filter(Boolean).join(" ");
  return `<pre class="${classes}"><code>${highlightCode(code, lang, escapeHtml)}</code></pre>`;
}

function inlineMarkdown(text, escapeHtml) {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return html;
}

function renderTable(lines, escapeHtml) {
  const rows = lines.map((line) =>
    line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => inlineMarkdown(cell.trim(), escapeHtml)),
  );
  const header = rows[0].map((cell) => `<th>${cell}</th>`).join("");
  const body = rows
    .slice(2)
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
}

export function renderMarkdown(markdown, escapeHtml) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let paragraph = [];
  let list = null;
  let code = null;
  let quote = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${inlineMarkdown(paragraph.join(" "), escapeHtml)}</p>`);
      paragraph = [];
    }
  };

  const flushList = () => {
    if (list) {
      html.push(`<${list.type}>${list.items.map((item) => `<li>${inlineMarkdown(item, escapeHtml)}</li>`).join("")}</${list.type}>`);
      list = null;
    }
  };

  const flushQuote = () => {
    if (quote.length) {
      html.push(`<blockquote>${quote.map((line) => `<p>${inlineMarkdown(line, escapeHtml)}</p>`).join("")}</blockquote>`);
      quote = [];
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (code) {
      if (/^```/.test(line)) {
        html.push(renderCodeBlock(code.lines.join("\n"), code.language, "", escapeHtml));
        code = null;
      } else {
        code.lines.push(line);
      }
      continue;
    }

    const fence = line.match(/^```\s*([\w-]+)?/);
    if (fence) {
      flushParagraph();
      flushList();
      flushQuote();
      code = { language: fence[1] || "text", lines: [] };
      continue;
    }

    const tableBlock = [line];
    while (index + 1 < lines.length && /^\s*\|.+\|\s*$/.test(lines[index + 1])) {
      tableBlock.push(lines[index + 1]);
      index += 1;
    }
    if (tableBlock.length >= 2 && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(tableBlock[1])) {
      flushParagraph();
      flushList();
      flushQuote();
      html.push(renderTable(tableBlock, escapeHtml));
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      flushQuote();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      flushQuote();
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMarkdown(heading[2], escapeHtml)}</h${level}>`);
      continue;
    }

    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quote.push(quoteMatch[1]);
      continue;
    }

    const unordered = line.match(/^\s*[-*]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (unordered || ordered) {
      flushParagraph();
      flushQuote();
      const type = unordered ? "ul" : "ol";
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push((unordered || ordered)[1]);
      continue;
    }

    paragraph.push(line.trim());
  }

  if (code) html.push(renderCodeBlock(code.lines.join("\n"), code.language, "", escapeHtml));
  flushParagraph();
  flushList();
  flushQuote();
  return html.length
    ? `<article class="markdown-preview">${html.join("\n")}</article>`
    : '<div class="empty-state">这个文档是空的</div>';
}
