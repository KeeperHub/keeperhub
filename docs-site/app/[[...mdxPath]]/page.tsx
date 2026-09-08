import { notFound } from "next/navigation";
import { generateStaticParamsFor, importPage } from "nextra/pages";
import { toDocsRelativePath } from "../../lib/docs-file-path";
import { useMDXComponents } from "../../mdx-components";

export const generateStaticParams = generateStaticParamsFor("mdxPath");

export async function generateMetadata(props: PageProps) {
  const params = await props.params;
  try {
    const { metadata } = await importPage(params.mdxPath);
    return metadata;
  } catch {
    return { title: "Not Found" };
  }
}

type PageProps = {
  params: Promise<{ mdxPath?: string[] }>;
};

export default async function Page(props: PageProps) {
  const params = await props.params;

  let result: Awaited<ReturnType<typeof importPage>>;
  try {
    result = await importPage(params.mdxPath);
  } catch {
    notFound();
  }

  const { default: MDXContent, ...rest } = result;
  const Wrapper = useMDXComponents().wrapper;

  // Nextra reports filePath relative to this project, and the prefix differs
  // between the symlink and copied content layouts. Reduce it to the path
  // relative to the docs content root, which is what docsRepositoryBase expects
  // appended to it. See lib/docs-file-path.ts.
  const metadata = { ...rest.metadata };
  if (typeof metadata.filePath === "string") {
    metadata.filePath = toDocsRelativePath(metadata.filePath);
  }

  return (
    <Wrapper {...rest} metadata={metadata}>
      <MDXContent {...props} params={params} />
    </Wrapper>
  );
}
