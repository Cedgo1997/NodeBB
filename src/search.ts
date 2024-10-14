import _, { Dictionary } from 'lodash';
import batch from './batch';
import categories from './categories';
import db from './database';
import { IPost, ITag, ITopic } from './interfaces/post';
import { ISearchData } from './interfaces/search';
import plugins from './plugins';
import posts from './posts';
import privileges from './privileges';
import topics from './topics';
import user from './user';
import utils from './utils';

export const search = {
    search: async function (data: ISearchData) {
        const start = process.hrtime();
        data.sortBy = data.sortBy || 'relevance';
        let result: any;

        if (['posts', 'titles', 'titlesposts', 'bookmarks'].includes(data.searchIn)) {
            result = await searchInContent(data);
        } else if (data.searchIn === 'users') {
            result = await user.search(data);
        } else if (data.searchIn === 'categories') {
            result = await categories.search(data);
        } else if (data.searchIn === 'tags') {
            result = await topics.searchAndLoadTags(data);
        } else if (data.searchIn) {
            result = await plugins.hooks.fire('filter:search.searchIn', {
                data,
            });
        } else {
            throw new Error('[[error:unknown-search-filter]]');
        }

        result.time = (process.elapsedTimeSince(start) / 1000).toFixed(2);
        return result;
    }
}

async function searchInContent(data: ISearchData) {
    data.uid = data.uid || 0;

    const [searchCids, searchUids] = await Promise.all([
        getSearchCids(data),
        getSearchUids(data),
    ]);

    async function doSearch(type: string, searchIn: string[]): Promise<number[]> {
        if (searchIn.includes(data.searchIn)) {
            const result = await plugins.hooks.fire('filter:search.query', {
                index: type,
                content: data.query,
                matchWords: data.matchWords || 'all',
                cid: searchCids,
                uid: searchUids,
                searchData: data,
                ids: [],
            });
            return Array.isArray(result) ? result : result.ids;
        }
        return [];
    }

    let pids = [];
    let tids = [];

    const inTopic = `${data.query || ''}`.match(/^in:topic-([\d]+) /);

    if (inTopic) {
        const tid = inTopic[1];
        const cleanedTerm = data.query.replace(inTopic[0], '');
        pids = await topics.search(tid, cleanedTerm);
    } else if (data.searchIn === 'bookmarks') {
        pids = await searchInBookmarks(data, searchCids, searchUids);
    } else {
        [pids, tids] = await Promise.all([
            doSearch('post', ['posts', 'titlesposts']),
            doSearch('topic', ['titles', 'titlesposts']),
        ]);
    }

    const mainPids = await topics.getMainPids(tids);

    let allPids = mainPids.concat(pids).filter(Boolean);

    allPids = await privileges.posts.filter('topics:read', allPids, data.uid);
    allPids = await filterAndSort(allPids, data);

    const metadata = await plugins.hooks.fire('filter:search.inContent', {
        pids: allPids,
        data: data,
    });

    if (data.returnIds) {
        const mainPidsSet = new Set(mainPids);
        const mainPidToTid = _.zipObject(mainPids, tids);
        const pidsSet = new Set(pids);
        const returnPids = allPids.filter(pid => pidsSet.has(pid));
        const returnTids = allPids.filter(pid => mainPidsSet.has(pid)).map(pid => mainPidToTid[pid]);
        return { pids: returnPids, tids: returnTids };
    }

    const itemsPerPage = Math.min(data.itemsPerPage || 10, 100);

    const returnData = {
        posts: [],
        matchCount: metadata.pids.length,
        pageCount: Math.max(1, Math.ceil(parseInt(metadata.pids.length, 10) / itemsPerPage)),
    };

    if (data.page) {
        const start = Math.max(0, (data.page - 1)) * itemsPerPage;
        metadata.pids = metadata.pids.slice(start, start + itemsPerPage);
    }

    returnData.posts = await posts.getPostSummaryByPids(metadata.pids, data.uid, {});
    await plugins.hooks.fire('filter:search.contentGetResult', { result: returnData, data: data });
    delete metadata.pids;
    delete metadata.data;
    return Object.assign(returnData, metadata);
}

async function searchInBookmarks(data: ISearchData, searchCids: number[], searchUids: number[]): Promise<number[]> {
    const { uid, query, matchWords } = data;
    const allPids: number[] = [];
    await batch.processSortedSet(`uid:${uid}:bookmarks`, async (pids: number[]) => {
        if (Array.isArray(searchCids) && searchCids.length) {
            pids = await posts.filterPidsByCid(pids, searchCids);
        }

        if (Array.isArray(searchUids) && searchUids.length) {
            pids = await posts.filterPidsByUid(pids, searchUids);
        }

        if (query) {
            const tokens = query.toString().split(' ');
            const postData = await db.getObjectsFields(pids.map(pid => `post:${pid}`), ['content', 'tid']);
            const tids: number[] = _.uniq(postData.map((p: { tid: number; }) => p.tid));
            const topicData = await db.getObjectsFields(tids.map(tid => `topic:${tid}`), ['title']);
            const tidToTopic: Dictionary<{ title: string }> = _.zipObject(tids, topicData);
            pids = pids.filter((_, i) => {
                const content = postData[i].content.toString();
                const title = tidToTopic[postData[i].tid].title.toString();
                const method = (matchWords === 'any' ? 'some' : 'every');
                return tokens[method](
                    token => content.includes(token) || title.includes(token)
                );
            });
        }
        allPids.push(...pids);
    }, {
        batch: 500,
    });

    return allPids;
}

async function filterAndSort(pids: number[], data: ISearchData): Promise<number[]> {
    if (data.sortBy === 'relevance' &&
        !data.replies &&
        !data.timeRange &&
        !data.hasTags &&
        data.searchIn !== 'bookmarks' &&
        !plugins.hooks.hasListeners('filter:search.filterAndSort')) {
        return pids;
    }
    let postsData = await getMatchedPosts(pids, data);
    if (!postsData.length) {
        return pids;
    }
    postsData = postsData.filter(Boolean);

    postsData = filterByPostcount(postsData, data.replies, data.repliesFilter);
    postsData = filterByTimerange(postsData, data.timeRange, data.timeFilter);
    postsData = filterByTags(postsData, data.hasTags);

    sortPosts(postsData, data);

    const result = await plugins.hooks.fire('filter:search.filterAndSort', { pids: pids, posts: postsData, data: data });
    return result.posts.map(post => post && post.pid);
}

async function getMatchedPosts(pids: number[], data: ISearchData): Promise<IPost[]> {
    const postFields = ['pid', 'uid', 'tid', 'timestamp', 'deleted', 'upvotes', 'downvotes'];

    let postsData = await posts.getPostsFields(pids, postFields);
    postsData = postsData.filter((post: IPost) => post && !post.deleted);
    const uids: number[] = _.uniq(postsData.map((post: IPost) => post.uid));
    const tids: number[] = _.uniq(postsData.map((post: IPost) => post.tid));

    const [users, topics] = await Promise.all([
        getUsers(uids, data),
        getTopics(tids, data),
    ]);

    const tidToTopic = _.zipObject(tids, topics);
    const uidToUser = _.zipObject(uids, users);

    postsData.forEach((post: IPost) => {
        if (topics && tidToTopic[post.tid]) {
            post.topic = tidToTopic[post.tid];
            if (post.topic && post.topic.category) {
                post.category = post.topic.category;
            }
        }

        if (uidToUser[post.uid]) {
            post.user = uidToUser[post.uid];
        }
    });

    return postsData.filter((post: IPost) => post && post.topic && !post.topic.deleted);
}

async function getUsers(uids: number[], data: ISearchData): Promise<any> {
    if (data.sortBy.startsWith('user')) {
        return user.getUsersFields(uids, ['username']);
    }
    return [];
}

async function getTopics(tids: number[], data: ISearchData): Promise<ITopic[]> {
    const topicsData = await topics.getTopicsData(tids);
    const cids: number[] = _.uniq(topicsData.map((topic: ITopic) => topic && topic.cid));
    const categories = await getCategories(cids, data);

    const cidToCategory = _.zipObject(cids, categories);
    topicsData.forEach((topic: ITopic) => {
        if (topic && categories && cidToCategory[topic.cid]) {
            topic.category = cidToCategory[topic.cid];
        }
        if (topic?.tags) {
            topic.tags = topic.tags.map((tag: ITag) => tag.value);
        }
    });

    return topicsData;
}

async function getCategories(cids: number[], data: ISearchData): Promise<Record<string, any>[]> {
    const categoryFields = [];

    if (data.sortBy.startsWith('category.')) {
        categoryFields.push(data.sortBy.split('.')[1]);
    }
    if (!categoryFields.length) {
        return null;
    }

    return await db.getObjectsFields(cids.map(cid => `category:${cid}`), categoryFields);
}

function filterByPostcount(posts: IPost[], postCount: string, repliesFilter: string): IPost[] {
    const parsedPostCount = parseInt(postCount, 10);
    if (postCount) {
        const filterCondition = repliesFilter === 'atleast'
            ? (post: IPost) => Number(post?.topic.postcount) >= parsedPostCount
            : (post: IPost) => Number(post?.topic.postcount) <= parsedPostCount;

        posts = posts.filter(filterCondition);
    }
    return posts;
}

function filterByTimerange(posts: IPost[], timeRange: string, timeFilter: string): IPost[] {
    const parsedTimeRange = parseInt(timeRange, 10) * 1000;
    if (timeRange) {
        const time = Date.now() - parsedTimeRange;
        if (timeFilter === 'newer') {
            posts = posts.filter(post => post.timestamp >= time);
        } else {
            posts = posts.filter(post => post.timestamp <= time);
        }
    }
    return posts;
}

function filterByTags(posts: IPost[], hasTags: string): IPost[] {
    if (Array.isArray(hasTags) && hasTags.length) {
        posts = posts.filter((post) => {
            let hasAllTags = false;
            if (post && post.topic && Array.isArray(post.topic.tags) && post.topic.tags.length) {
                hasAllTags = hasTags.every(tag => post.topic.tags.includes(tag));
            }
            return hasAllTags;
        });
    }
    return posts;
}

function sortPosts(posts: IPost[], data: ISearchData): IPost[] {
    if (!posts.length || data.sortBy === 'relevance') {
        return;
    }

    data.sortDirection = data.sortDirection || 'desc';
    const direction = data.sortDirection === 'desc' ? 1 : -1;
    const fields = data.sortBy.split('.');

    if (fields.length === 1) {
        return posts.sort((post_1, post_2) => direction * (post_2[fields[0]] - post_1[fields[0]]));
    }

    const firstPost = posts[0];
    const isValid = fields && fields.length === 2 && firstPost?.[fields[0]]?.[fields[1]];
    if (!isValid) {
        return;
    }

    const isNumeric = utils.isNumber(firstPost[fields[0]][fields[1]]);

    if (isNumeric) {
        posts.sort((post_1, post_2) => direction * (post_2[fields[0]][fields[1]] - post_1[fields[0]][fields[1]]));
    } else {
        posts.sort((post_1, post_2) => {
            if (post_1[fields[0]][fields[1]] > post_2[fields[0]][fields[1]]) {
                return direction;
            } else if (post_1[fields[0]][fields[1]] < post_2[fields[0]][fields[1]]) {
                return -direction;
            }
            return 0;
        });
    }
}

async function getSearchCids(data: ISearchData): Promise<number[]> {
    if (!Array.isArray(data.categories) || !data.categories.length) {
        return [];
    }

    if (data.categories.includes('all')) {
        return await categories.getCidsByPrivilege('categories:cid', data.uid, 'read');
    }

    const [watchedCids, childrenCids] = await Promise.all([
        getWatchedCids(data),
        getChildrenCids(data),
    ]);
    return _.uniq(watchedCids.concat(childrenCids).concat(data.categories).filter(Boolean));
}

async function getWatchedCids(data) {
    if (!data.categories.includes('watched')) {
        return [];
    }
    return await user.getWatchedCategories(data.uid);
}

async function getChildrenCids(data) {
    if (!data.searchChildren) {
        return [];
    }
    const childrenCids = await Promise.all(data.categories.map(cid => categories.getChildrenCids(cid)));
    return await privileges.categories.filterCids('find', _.uniq(_.flatten(childrenCids)), data.uid);
}

async function getSearchUids(data) {
    if (!data.postedBy) {
        return [];
    }
    return await user.getUidsByUsernames(Array.isArray(data.postedBy) ? data.postedBy : [data.postedBy]);
}