/**
 * The GraphQL documents, and the shapes they come back as.
 *
 * Discussions and Projects v2 exist only on GitHub's GraphQL API — there is no REST
 * equivalent to fall back to — so these queries are load-bearing rather than an
 * optimization. They are written out as plain strings because a query builder would add a
 * layer to read through without removing one: a string is exactly as readable as the query
 * it sends, and it is what you paste into GitHub's GraphQL explorer when a result surprises
 * you.
 *
 * Three things are deliberate and worth not "tidying up" later:
 *
 * 1. EVERY CONNECTION IS PAGED, AND EVERY PAGE RETURNS ITS `endCursor`. The provider
 *    contract says listing is paged and never "return an array" (see `core/provider.ts`),
 *    and a repository with four thousand discussions is not hypothetical. `first` is always
 *    a variable so the engine's `limit` reaches the server rather than being trimmed after
 *    the fact.
 *
 * 2. OWNER-LEVEL PROJECTS ASK VIA INLINE FRAGMENTS ON `Organization` AND `User`, not via
 *    the `ProjectV2Owner` interface. A mount lists `owner/repo` pairs and cannot know which
 *    kind of account an owner is; asking for both and taking whichever answered means the
 *    config never has to say, and a personal account works identically to an org.
 *
 * 3. BODIES ARE FETCHED AS BOTH `body` AND `bodyText`. `body` is the Markdown source, which
 *    is what gets rendered; `bodyText` is GitHub's plain-text flattening, which is what the
 *    one-line `summary` should come from. Deriving the summary from Markdown instead would
 *    put image syntax and link brackets into the line a screen reader announces first.
 */

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';

/**
 * Field values carried by a project item.
 *
 * Projects v2 has no fixed schema — every board defines its own fields — so this asks for
 * every value type the API can return and lets the provider flatten them into `meta`. The
 * alternative, naming the fields the query wants, would mean a config file listing the
 * columns of every board, which is precisely the coupling that makes a tool break the first
 * time somebody renames "Status" to "Stage".
 */
const FIELD_VALUES = `
  fieldValues(first: 20) {
    nodes {
      __typename
      ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
      ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } }
      ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } }
      ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
      ... on ProjectV2ItemFieldIterationValue { title startDate field { ... on ProjectV2FieldCommon { name } } }
    }
  }`;

const PROJECT_FIELDS = `
  id
  number
  title
  url
  closed
  public
  shortDescription
  createdAt
  updatedAt
  items { totalCount }`;

// ---------------------------------------------------------------------------
// Discussions
// ---------------------------------------------------------------------------

export const DISCUSSIONS_QUERY = `
query Discussions($owner: String!, $repo: String!, $first: Int!, $after: String, $categoryId: ID) {
  repository(owner: $owner, name: $repo) {
    discussions(
      first: $first
      after: $after
      categoryId: $categoryId
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      totalCount
      ${PAGE_INFO}
      nodes {
        id
        number
        title
        bodyText
        url
        createdAt
        updatedAt
        upvoteCount
        locked
        isAnswered
        author { login }
        category { name slug emoji }
        comments { totalCount }
      }
    }
  }
}`;

export const DISCUSSION_CATEGORIES_QUERY = `
query DiscussionCategories($owner: String!, $repo: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    discussionCategories(first: $first, after: $after) {
      ${PAGE_INFO}
      nodes { id name slug emoji description isAnswerable }
    }
  }
}`;

/**
 * One discussion with its thread.
 *
 * Replies are nested one level below comments because that is exactly how deep GitHub
 * allows discussion threading to go — there is no reply-to-a-reply — so a single extra
 * level is complete rather than a truncation the reader has to wonder about.
 */
export const DISCUSSION_QUERY = `
query Discussion($owner: String!, $repo: String!, $number: Int!, $comments: Int!) {
  repository(owner: $owner, name: $repo) {
    discussion(number: $number) {
      id
      number
      title
      body
      url
      createdAt
      updatedAt
      upvoteCount
      locked
      isAnswered
      author { login }
      category { name emoji isAnswerable }
      answer { id }
      comments(first: $comments) {
        totalCount
        ${PAGE_INFO}
        nodes {
          id
          body
          createdAt
          upvoteCount
          isAnswer
          author { login }
          replies(first: 50) {
            totalCount
            nodes { id body createdAt author { login } }
          }
        }
      }
    }
  }
}`;

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const OWNER_PROJECTS_QUERY = `
query OwnerProjects($login: String!, $first: Int!, $after: String) {
  repositoryOwner(login: $login) {
    __typename
    ... on Organization {
      projectsV2(first: $first, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
        totalCount
        ${PAGE_INFO}
        nodes { ${PROJECT_FIELDS} }
      }
    }
    ... on User {
      projectsV2(first: $first, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
        totalCount
        ${PAGE_INFO}
        nodes { ${PROJECT_FIELDS} }
      }
    }
  }
}`;

export const REPO_PROJECTS_QUERY = `
query RepoProjects($owner: String!, $repo: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    projectsV2(first: $first, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      totalCount
      ${PAGE_INFO}
      nodes { ${PROJECT_FIELDS} }
    }
  }
}`;

/**
 * The items on one board, addressed by the project's node id.
 *
 * By id rather than by `owner + number` because a project reached through a repository is
 * frequently owned by the organization, so re-deriving a lookup from where it was listed
 * would ask the wrong account. The id travels on the node the engine already holds.
 */
export const PROJECT_ITEMS_QUERY = `
query ProjectItems($id: ID!, $first: Int!, $after: String) {
  node(id: $id) {
    ... on ProjectV2 {
      id
      title
      items(first: $first, after: $after) {
        totalCount
        ${PAGE_INFO}
        nodes {
          id
          type
          isArchived
          createdAt
          updatedAt
          ${FIELD_VALUES}
          content {
            __typename
            ... on DraftIssue {
              title
              bodyText
              createdAt
              updatedAt
              creator { login }
            }
            ... on Issue {
              number
              title
              bodyText
              url
              state
              createdAt
              updatedAt
              author { login }
              repository { nameWithOwner }
            }
            ... on PullRequest {
              number
              title
              bodyText
              url
              state
              isDraft
              merged
              createdAt
              updatedAt
              author { login }
              repository { nameWithOwner }
            }
          }
        }
      }
    }
  }
}`;

/** The body of a single project item, fetched only when one is opened. */
export const PROJECT_ITEM_BODY_QUERY = `
query ProjectItemBody($id: ID!) {
  node(id: $id) {
    ... on ProjectV2Item {
      id
      ${FIELD_VALUES}
      content {
        __typename
        ... on DraftIssue { title body createdAt updatedAt creator { login } }
        ... on Issue { number title body url state createdAt updatedAt author { login } repository { nameWithOwner } }
        ... on PullRequest {
          number title body url state isDraft merged createdAt updatedAt
          author { login } repository { nameWithOwner }
        }
      }
    }
  }
}`;

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface PageInfo {
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

export interface Connection<T> {
  readonly totalCount?: number;
  readonly pageInfo?: PageInfo;
  readonly nodes: readonly (T | null)[] | null;
}

export interface Actor {
  readonly login: string;
}

export interface DiscussionCategory {
  readonly id?: string;
  readonly name: string;
  readonly slug?: string;
  readonly emoji?: string | null;
  readonly description?: string | null;
  readonly isAnswerable?: boolean;
}

export interface DiscussionSummary {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly bodyText: string | null;
  readonly url: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly upvoteCount: number;
  readonly locked: boolean;
  readonly isAnswered: boolean | null;
  readonly author: Actor | null;
  readonly category: DiscussionCategory | null;
  readonly comments: { readonly totalCount: number } | null;
}

export interface DiscussionReply {
  readonly id: string;
  readonly body: string | null;
  readonly createdAt: string;
  readonly author: Actor | null;
}

export interface DiscussionComment extends DiscussionReply {
  readonly upvoteCount: number;
  readonly isAnswer: boolean;
  readonly replies: Connection<DiscussionReply> | null;
}

export interface DiscussionDetail {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly url: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly upvoteCount: number;
  readonly locked: boolean;
  readonly isAnswered: boolean | null;
  readonly author: Actor | null;
  readonly category: DiscussionCategory | null;
  readonly answer: { readonly id: string } | null;
  readonly comments: Connection<DiscussionComment> | null;
}

export interface ProjectSummary {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly closed: boolean;
  readonly public: boolean;
  readonly shortDescription: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly items: { readonly totalCount: number } | null;
}

export interface ProjectFieldValue {
  readonly __typename: string;
  readonly field?: { readonly name?: string } | null;
  readonly text?: string | null;
  readonly number?: number | null;
  readonly date?: string | null;
  readonly name?: string | null;
  readonly title?: string | null;
  readonly startDate?: string | null;
}

export interface ProjectItemContent {
  readonly __typename?: string;
  readonly number?: number;
  readonly title?: string;
  readonly body?: string | null;
  readonly bodyText?: string | null;
  readonly url?: string;
  readonly state?: string;
  readonly isDraft?: boolean;
  readonly merged?: boolean;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly author?: Actor | null;
  readonly creator?: Actor | null;
  readonly repository?: { readonly nameWithOwner: string } | null;
}

export interface ProjectItem {
  readonly id: string;
  readonly type: string;
  readonly isArchived: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly fieldValues: Connection<ProjectFieldValue> | null;
  readonly content: ProjectItemContent | null;
}

export interface DiscussionsResponse {
  readonly repository: { readonly discussions: Connection<DiscussionSummary> | null } | null;
}

export interface DiscussionCategoriesResponse {
  readonly repository: { readonly discussionCategories: Connection<DiscussionCategory> | null } | null;
}

export interface DiscussionResponse {
  readonly repository: { readonly discussion: DiscussionDetail | null } | null;
}

export interface OwnerProjectsResponse {
  readonly repositoryOwner:
    | { readonly __typename?: string; readonly projectsV2?: Connection<ProjectSummary> | null }
    | null;
}

export interface RepoProjectsResponse {
  readonly repository: { readonly projectsV2: Connection<ProjectSummary> | null } | null;
}

export interface ProjectItemsResponse {
  readonly node: { readonly id?: string; readonly title?: string; readonly items?: Connection<ProjectItem> | null } | null;
}

export interface ProjectItemBodyResponse {
  readonly node: (Pick<ProjectItem, 'id' | 'fieldValues' | 'content'> | null) | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drop the nulls GraphQL puts in `nodes` for entries the viewer may not see. */
export function nodesOf<T>(connection: Connection<T> | null | undefined): readonly T[] {
  return (connection?.nodes ?? []).filter((node): node is T => node !== null && node !== undefined);
}

/** The cursor to ask for next, or undefined when this was the last page. */
export function nextCursor(connection: Connection<unknown> | null | undefined): string | undefined {
  const info = connection?.pageInfo;
  if (info === undefined || !info.hasNextPage || info.endCursor === null) return undefined;
  return info.endCursor;
}

/**
 * Flatten a project item's field values into `name -> display string` pairs.
 *
 * Everything becomes a string because `meta` values are scalars that `stat` prints and
 * `meta:key=value` matches against; a date rendered as an ISO string and a single-select
 * rendered as its option name are both things a user can reasonably type.
 */
export function fieldValueMap(item: ProjectItem): Map<string, string> {
  const out = new Map<string, string>();
  for (const value of nodesOf(item.fieldValues)) {
    const name = value.field?.name;
    if (name === undefined || name === '') continue;
    const display =
      value.text ??
      value.name ??
      value.title ??
      value.date ??
      (value.number === null || value.number === undefined ? undefined : String(value.number));
    if (display === undefined || display === '') continue;
    out.set(name, display);
  }
  return out;
}
