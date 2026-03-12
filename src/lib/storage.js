import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

const s3Client = new S3Client({
    endpoint: `http${process.env.MINIO_USE_SSL === 'true' ? 's' : ''}://${process.env.MINIO_ENDPOINT}:${process.env.MINIO_PORT}`,
    region: 'us-east-1',
    credentials: {
        accessKeyId: process.env.MINIO_ACCESS_KEY,
        secretAccessKey: process.env.MINIO_SECRET_KEY,
    },
    forcePathStyle: true,
});

export function getPublicUrl(bucket, path) {
    return `${process.env.MINIO_PUBLIC_URL}/${bucket}/${path}`;
}

export async function uploadFile(bucket, key, body, contentType) {
    await s3Client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
    }));
    return getPublicUrl(bucket, key);
}

export async function deleteFile(bucket, key) {
    await s3Client.send(new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
    }));
}

export { s3Client };
export default s3Client;
