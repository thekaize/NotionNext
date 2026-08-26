import BLOG from '@/blog.config'
import NotionPage from '@/components/NotionPage'
import { fetchGlobalAllData, getPostBlocks } from '@/lib/db/SiteDataApi'
import { formatNotionBlock } from '@/lib/db/notion/getPostBlocks'
import { adapterNotionBlockMap } from '@/lib/utils/notion.util'
import { Feed } from 'feed'
import ReactDOMServer from 'react-dom/server'

/**
 * In-memory RSS cache to avoid regenerating on every request.
 */
let rssCache = {
  xml: null,
  atomXml: null,
  json: null,
  updatedAt: 0
}

const CACHE_TTL_MS = 10 * 60 * 1000 // 10 分钟缓存

function isCacheFresh() {
  return rssCache.xml && Date.now() - rssCache.updatedAt < CACHE_TTL_MS
}

/**
 * 渲染文章全文 HTML 的辅助函数
 */
async function createFeedContent(post) {
  if (post.password && post.password !== '') {
    return post.summary || ''
  }
  try {
    const blockMap = await getPostBlocks(post.id, 'rss-content')
    if (blockMap) {
      post.blockMap = adapterNotionBlockMap(blockMap)
      if (post.blockMap?.block) {
        post.blockMap.block = formatNotionBlock(post.blockMap.block)
      }
      
      const content = ReactDOMServer.renderToString(<NotionPage post={post} />)
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
 */
async function generateRssContent() {
  const locale = BLOG.LANG
  const pageId = BLOG.NOTION_PAGE_ID

  const pageIds = pageId.split(',')
  const targetId = pageIds[0].includes(':')
    ? pageIds[0].split(':')[1]
    : pageIds[0]

  const props = await fetchGlobalAllData({ from: 'rss-api', pageId: targetId, locale })
  if (!props || !props.allPages) {
    return null
  }

  const { siteInfo, allPages, NOTION_CONFIG } = props

  // 1. 提取所有已发布的文章（不再限制只能取 10 篇，但为了防止 XML 文件过大，上限暂设为 100 篇，你也可以去掉 slice(0,100) 输出全部）
  const latestPosts = allPages
    .filter(p => p.type === 'Post' && p.status === 'Published')
    .sort((a, b) => {
      const dateA = new Date(a.publishDay || a.publishDate || 0)
      const dateB = new Date(b.publishDay || b.publishDate || 0)
      return dateB - dateA
    })
    .slice(0, 100) 

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

  // 2. 核心修改：利用循环的序号 i 来判断
  for (let i = 0; i < latestPosts.length; i++) {
    const post = latestPosts[i]
    
    // 如果是前 10 篇 (i < 10)，就去渲染全文；如果是 10 篇以后，直接用摘要，瞬间完成！
    const contentHTML = i < 10 ? await createFeedContent(post) : (post.summary || '')

    feed.addItem({
      title: post.title,
      link: `${LINK}/${post.slug}`,
      description: post.summary || '',
      content: contentHTML, // 前10篇是长文，后面的只是摘要
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
