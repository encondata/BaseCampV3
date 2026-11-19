/** The bundled troubleshooting topics. The JSON and PNG files in this
 *  folder are the canonical copy mirrored to the Android and iOS apps
 *  (scripts/troubleshooting/sync.sh); this file is web-only. */

import topicsJson from './topics.json';
import type { DocNode } from './WikiDoc';

export interface Topic {
  id: string;
  title: string;
  blurb: string;
  doc: string;
}

const DOCS = import.meta.glob<DocNode>('./*.json', { eager: true, import: 'default' });
const IMAGES = import.meta.glob<string>('./*.png', { eager: true, query: '?url', import: 'default' });

export const TOPICS: Topic[] = topicsJson as Topic[];

export function findTopic(id: string): Topic | undefined {
  return TOPICS.find((t) => t.id === id);
}

export function topicDoc(topic: Topic): DocNode | undefined {
  return DOCS[`./${topic.doc}`];
}

export function topicImageUrl(file: string): string {
  return IMAGES[`./${file}`] ?? '';
}
