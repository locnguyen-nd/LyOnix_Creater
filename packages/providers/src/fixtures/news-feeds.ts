/**
 * VE2E-96 fixtures: RSS documents shaped like the Yahoo! JAPAN feeds seen on 2026-10-07 (category feed: title with the publisher in
 * parentheses, link, pubDate, image, comments, description; topics feed: title, link, pubDate, comments only). Headlines are made up.
 */
export const YAHOO_CATEGORY_SPORTS_RSS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<rss version="2.0">
  <channel>
    <language>ja</language>
    <copyright>© LY Corporation</copyright>
    <title> スポーツ - Yahoo!ニュース</title>
    <link>https://news.yahoo.co.jp/categories/sports?source=rss</link>
    <description>Yahoo! JAPANのニュースに掲載されている記事の最新の見出しを提供しています。</description>
    <image><title>Yahoo!ニュース</title><link>https://news.yahoo.co.jp/</link><url>https://s.yimg.jp/images/news/yjnews_s.gif</url></image>
    <item>
      <title>架空投手が7回1失点の快投　突破に王手　(スポーツ架空)</title>
      <link>https://news.yahoo.co.jp/articles/aaaa1111bbbb2222?source=rss</link>
      <pubDate>Wed, 07 Oct 2026 03:46:42 GMT</pubDate>
      <image>https://newsatcl-pctr.c.yimg.jp/t/amd-img/fixture-1.jpg?pri=l&amp;w=450&amp;h=300</image>
      <comments>https://news.yahoo.co.jp/articles/aaaa1111bbbb2222/comments</comments>
      <description>◆架空リーグ 地区シリーズ第３戦 架空チームが３―１で勝利。先発投手は&amp;quot;最高峰&amp;quot;と評された（２</description>
    </item>
    <item>
      <title>架空リーグが開幕週の事象を説明「しっかり守る」(バスケ架空)</title>
      <link>https://news.yahoo.co.jp/articles/cccc3333dddd4444?source=rss</link>
      <pubDate>Wed, 07 Oct 2026 03:46:15 GMT</pubDate>
      <image>https://newsatcl-pctr.c.yimg.jp/t/amd-img/fixture-2.jpg</image>
      <description><![CDATA[<p>架空リーグは10月7日、<b>開幕週</b>に発生した事象について説明した。</p>]]></description>
    </item>
    <item>
      <title>リンク先が外部の項目</title>
      <link>https://example.com/elsewhere?source=rss</link>
      <pubDate>Wed, 07 Oct 2026 03:40:00 GMT</pubDate>
    </item>
    <item>
      <title></title>
      <link>https://news.yahoo.co.jp/articles/eeee5555?source=rss</link>
    </item>
  </channel>
</rss>`;

export const YAHOO_TOPICS_TOP_PICKS_RSS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<rss version="2.0">
  <channel>
    <language>ja</language>
    <title>Yahoo!ニュース・トピックス - 主要</title>
    <link>https://news.yahoo.co.jp/topics/top-picks?source=rss</link>
    <item>
      <title>架空大臣 会見で辞任を否定</title>
      <link>https://news.yahoo.co.jp/pickup/6500001?source=rss</link>
      <pubDate>Wed, 07 Oct 2026 03:00:42 GMT</pubDate>
      <comments>https://news.yahoo.co.jp/articles/ffff6666/comments</comments>
    </item>
    <item>
      <title>架空政府 補正予算を検討 (続報)</title>
      <link>https://news.yahoo.co.jp/pickup/6500002?source=rss</link>
      <pubDate>Wed, 07 Oct 2026 02:11:56 GMT</pubDate>
    </item>
  </channel>
</rss>`;

/** A hostile document: a DOCTYPE with entities must never be expanded. */
export const RSS_WITH_DOCTYPE_ENTITY = `<?xml version="1.0"?>
<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<rss version="2.0"><channel>
  <item><title>危険 &xxe; タイトル</title><link>https://news.yahoo.co.jp/articles/abc123?source=rss</link></item>
</channel></rss>`;
