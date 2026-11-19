import { createBinaryData } from './binary-data';
import type { N8nItem } from './n8n-helper';

interface S3Download {
  item: N8nItem;
  bucket: string;
  key: string;
  binaryProperty: string;
}

interface S3ClientConfig {
  endpoint: string;
  region: string;
  forcePathStyle: boolean;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
}

interface S3Client {
  send(command: object): Promise<{
    Body?: { transformToByteArray(): Promise<Uint8Array> };
    ContentType?: string;
  }>;
  destroy(): void;
}

function readS3Config(): S3ClientConfig {
  const { S3_ENDPOINT, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN } = process.env;
  if (!S3_ENDPOINT || !AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
    throw new Error('S3 Download requires S3_ENDPOINT, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY at runtime');
  }
  try {
    const endpoint = new URL(S3_ENDPOINT);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
      throw new Error('invalid endpoint');
    }
  } catch {
    throw new Error('S3_ENDPOINT must be an HTTP or HTTPS URL without embedded credentials');
  }
  return {
    endpoint: S3_ENDPOINT,
    region: process.env.AWS_REGION || 'us-east-1',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
      sessionToken: AWS_SESSION_TOKEN,
    },
  };
}

export async function downloadS3Files(downloads: S3Download[]): Promise<N8nItem[]> {
  if (downloads.length === 0) return [];
  const config = readS3Config();
  // Keep the optional SDK visible to Bun's executable bundler.
  const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3' as string) as {
    S3Client: new (config: S3ClientConfig) => S3Client;
    GetObjectCommand: new (input: { Bucket: string; Key: string }) => object;
  };
  const client = new S3Client(config);
  try {
    const items: N8nItem[] = [];
    for (const { item, bucket, key, binaryProperty } of downloads) {
      if (!bucket || !key || key.endsWith('/') || !binaryProperty) {
        throw new Error('S3 Download requires a bucket, file key and output binary property');
      }
      let bytes: Uint8Array;
      let contentType: string | undefined;
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!response.Body) throw new Error('empty response');
        bytes = await response.Body.transformToByteArray();
        contentType = response.ContentType;
      } catch (error) {
        if (error instanceof Error && (error.name === 'NoSuchKey' || error.name === 'NotFound')) {
          throw new Error('S3 Download could not find the requested object');
        }
        throw new Error('S3 Download failed');
      }
      const fileName = key.slice(key.lastIndexOf('/') + 1);
      items.push({
        ...item,
        binary: { ...item.binary, [binaryProperty]: createBinaryData(bytes, fileName, contentType) },
      });
    }
    return items;
  } finally {
    client.destroy();
  }
}
