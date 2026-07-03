import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "../apps/web/src/components/MarkdownContent.js";

describe("web markdown rendering", () => {
  it("renders assistant markdown headings, emphasis, and gfm tables", () => {
    const html = renderToStaticMarkup(React.createElement(MarkdownContent, {
      content: [
        "## 一、阿里巴巴",
        "",
        "| 数据库 | 类型 |",
        "|---|---|",
        "| **OceanBase** | 分布式关系型 |"
      ].join("\n")
    }));

    expect(html).toContain("<h2>一、阿里巴巴</h2>");
    expect(html).toContain("<table>");
    expect(html).toContain("<strong>OceanBase</strong>");
    expect(html).not.toContain("## 一、阿里巴巴");
    expect(html).not.toContain("| 数据库 | 类型 |");
  });
});
