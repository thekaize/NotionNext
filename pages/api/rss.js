import BLOG from '@/blog.config'
import NotionPage from '@/components/NotionPage'
import { fetchGlobalAllData, getPostBlocks } from '@/lib/db/SiteDataApi'
import { formatNotionBlock } from '@/lib/db/notion/getPostBlocks'
import { adapterNotionBlockMap } from '@/lib/utils/notion.util'
import { Feed } from 'feed'
import ReactDOMServer from 'react-dom/server'

/**
 * In-memory RSS cache to avoid regenerating on every request.
 * Survives across ISR revalidations within the same serverless instance.
 */
let rssCache = {
  xml: null,
  atomXml: null,
  json: null,
  updatedAt: 0
}

const CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes

function isCacheFresh() {
  return rssCache.xml && Date.now() - rssCache.updatedAt < CACHE_TTL_MS
}

/**
 * 渲染文章全文 HTML 的辅助函数
 */
async function createFeedContent(post) {
  // 加密的文章内容只返回摘要
  if (post.password && post.password !== '') {
    return post.summary || ''
  }
  try {
    const blockMap = await getPostBlocks(post.id, 'rss-content')
    if (blockMap) {
      post.blockMap = adapterNotionBlockMap(blockMap)
      // 格式化内容，部分的样式字段格式在此处理
      if (post.blockMap?.block) {
        post.blockMap.block = formatNotionBlock(post.blockMap.block)
      }
      
      // 将 React 组件渲染为静态 HTML 字符串
      const content = ReactDOMServer.renderToString(<NotionPage post={post} />)
      // 使用正则过滤掉 Notion 页面的属性头部（避免在正文中显示冗余的标签/日期字段）
      const regexExp =
        /<div class="notion-collection-row"><div class="notion-collection-row-body"><div class="notion-collection-row-property"><div class="notion-collection-column-title"><svg.*?class="notion-collection-column-title-icon">.*?<\/svg><div class="notion-collection-column-title-body">.*?<\/div><\/div><div class="notion-collection-row-value">.*?<\/div><\/div><\/div><\/div>/g
      return content.replace(regexExp, '')
    }
  } catch (err) {
    console.error(`[RSS API] Failed to render content for post ${post.id}:`, err)
  }
  return post.summary || ''
}

/**
 * Generate RSS feed content from site data.
 * Reuses the same data pipeline as the homepage getStaticProps.
 */
async function generateRssContent() {
  const locale = BLOG.LANG
  const defaultLocale = BLOG.LANG
  const pageId = BLOG.NOTION_PAGE_ID

  // Parse the first (default) page ID for data fetching
  const pageIds = pageId.split(',')
  const targetId = pageIds[0].includes(':')
    ? pageIds[0].split(':')[1]
    : pageIds[0]

  const props = await fetchGlobalAllData({ from: 'rss-api', pageId: targetId, locale })
  if (!props || !props.allPages) {
    return null
  }

  const { siteInfo, allPages, NOTION_CONFIG } = props

  // Filter published posts only
  // 注意：为了防止服务器渲染超时，这里把拉取数量从 20 减少到了 10
  const latestPosts = allPages
    .filter(p => p.type === 'Post' && p.status === 'Published')
    .sort((a, b) => {
      const dateA = new Date(a.publishDay || a.publishDate || 0)
      const dateB = new Date(b.publishDay || b.publishDate || 0)
      return dateB - dateA
    })
    .slice(0, 10)

  if (latestPosts.length === 0) {
    return null
  }

  const TITLE = siteInfo?.title || BLOG.AUTHOR
  const DESCRIPTION = siteInfo?.description || BLOG.BIO
  const LINK = siteInfo?.link || BLOG.LINK
  const AUTHOR = NOTION_CONFIG?.AUTHOR || BLOG.AUTHOR
  const LANG = NOTION_CONFIG?.LANG || BLOG.LANG
  const year = new Date().getFullYear()

  const feed = new Feed({
    title: TITLE,
    description: DESCRIPTION,
    link: LINK,
    language: LANG,
    favicon: `${LINK}/favicon.png`,
    copyright: `All rights reserved ${year}, ${AUTHOR}`,
    author: {
      name: AUTHOR,
      link: LINK
    }
  })

  // 逐个生成每篇文章的详细内容
  for (const post of latestPosts) {
    const fullContent = await createFeedContent(post)
    feed.addItem({
      title: post.title,
      link: `${LINK}/${post.slug}`,
      description: post.summary || '',
      content: fullContent, // 👈 在这里把 HTML 正文塞入 RSS
      date: new Date(post?.publishDay || post?.publishDate || Date.now())
    })
  }

  return {
    xml: feed.rss2(),
    atomXml: feed.atom1(),
    json: feed.json1()
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method Not Allowed' })
  }

  try {
    if (!isCacheFresh()) {
      const content = await generateRssContent()
      if (content) {
        rssCache = {
          ...content,
          updatedAt: Date.now()
        }
      }
    }

    if (!rssCache.xml) {
      return res.status(503).json({ message: 'RSS feed not available' })
    }

    const format = req.query.format || 'rss'

    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600')

    if (format === 'atom') {
      res.setHeader('Content-Type', 'application/atom+xml; charset=utf-8')
      return res.status(200).send(rssCache.atomXml)
    }

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      return res.status(200).send(rssCache.json)
    }

    // Default: RSS 2.0
    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8')
    return res.status(200).send(rssCache.xml)
  } catch (error) {
    console.error('[RSS API] Error generating feed:', error)
    return res.status(500).json({ message: 'Failed to generate RSS feed' })
  }
}
