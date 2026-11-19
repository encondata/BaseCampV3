/** One troubleshooting guide, rendered from its bundled wiki document. */

import { Link, useParams } from 'react-router-dom';

import { findTopic, topicDoc } from '../troubleshooting/topics';
import WikiDoc from '../troubleshooting/WikiDoc';

export default function TroubleshootingTopic() {
  const { topicId = '' } = useParams();
  const topic = findTopic(topicId);
  const doc = topic ? topicDoc(topic) : undefined;
  if (!topic || !doc) {
    return (
      <div className="portal-page">
        <div className="eyebrow">Kiosk</div>
        <h1 className="page-title">Troubleshooting</h1>
        <p>This topic isn't available.</p>
        <Link className="btn" to="/troubleshooting">Back to Troubleshooting</Link>
      </div>
    );
  }
  return (
    <div className="portal-page">
      <div className="eyebrow">Kiosk</div>
      <h1 className="page-title">{topic.title}</h1>
      <WikiDoc doc={doc} />
    </div>
  );
}
