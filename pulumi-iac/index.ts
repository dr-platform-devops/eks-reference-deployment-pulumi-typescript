import * as aws from "@pulumi/aws";
import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

//Let us pull in some variables from the stack yaml file
let config = new pulumi.Config("localconfig");
const cidrIP = config.require("cidrIP");

//Let's name the kubernetes cluster
const kubeClusterName = 'eks-cluster';

//Creates a role for the Node Groups that will join the cluster.
const roleForNodeGroup = new aws.iam.Role("roleDefinition", {
    assumeRolePolicy: JSON.stringify({
        Statement: [
            {
                Action: "sts:AssumeRole",
                Effect: "Allow",
                Principal: {
                    Service: "ec2.amazonaws.com",
                },
            },
        ],
        Version: "2012-10-17",
    }),
});


//Defines the EKS cluster
const cluster = new eks.Cluster(
    kubeClusterName,
    {
        name: kubeClusterName,
        createOidcProvider: true,
        endpointPrivateAccess: true,
        endpointPublicAccess: true,
        //Uncomment if you have to set it into a specific one. If unset, the default of the AWS account will be used.
        //vpcId: "SetIfNeeded",
        //Please see the following comments for the subnet IDs: https://www.pulumi.com/registry/packages/eks/api-docs/cluster/#subnetids_nodejs
        // subnetIds: [
        //     "SetIfNeeded",
        // ],
        skipDefaultNodeGroup: true,
        //Define the CIDR block that can access the kube API
        publicAccessCidrs: [
            "92.63.242.142/32",
        ],
        roleMappings: [
            {
                groups: ["system:bootstrappers", "system:masters", "system:nodes"],
                roleArn: roleForNodeGroup.arn,
                username: "system:node:{{SessionName}}",
            }
        ],
    },
    {
        dependsOn: roleForNodeGroup,
    },
);

//Creates roles necessary for the node groups to join
const K8sNGPolicy = new aws.iam.RolePolicyAttachment(
    "K8sNGPolicy",
    {
        policyArn: "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
        role: roleForNodeGroup.name,
    },
    {
        dependsOn: roleForNodeGroup,
    },
);

const EBSIrsaRole = new aws.iam.Role(
    "EBSIrsaRole",
    {
        assumeRolePolicy: pulumi
            .all([cluster.core.oidcProvider?.arn!, cluster.core.oidcProvider?.url!])
            .apply(([oidcArn, oidcUrl]) =>
                JSON.stringify({
                    Statement: [
                        {
                            Action: "sts:AssumeRoleWithWebIdentity",
                            Effect: "Allow",
                            Condition: {
                                StringEquals: {
                                    [`${oidcUrl}:aud`]: "sts.amazonaws.com",
                                    [`${oidcUrl}:sub`]:
                                        "system:serviceaccount:kube-system:ebs-csi-controller-sa",
                                },
                            },
                            Principal: {
                                Federated: oidcArn,
                            },
                        },
                    ],
                    Version: "2012-10-17",
                }),
            ),
    },
    {
        dependsOn: cluster,
    },
);


//Create roles for Add-ons and registry access

const RegistryAccess = new aws.iam.RolePolicyAttachment(
    "RegistryAccess",
    {
        policyArn: "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
        role: roleForNodeGroup.name,
    },
);

const CNIAddonPolicy = new aws.iam.RolePolicyAttachment("CNIAddonPolicy", {
    policyArn: "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    role: roleForNodeGroup.name,
});


const EBSIrsaRoleAttachment = new aws.iam.RolePolicyAttachment(
    "EBSIrsaRoleAttachment",
    {
        policyArn: "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy",
        role: EBSIrsaRole.name,
    },
    {
        dependsOn: EBSIrsaRole,
    },
);

// Install necessary add-ons

const AddonKubeProxy = new aws.eks.Addon(
    "AddonKubeProxy",
    {
        clusterName: kubeClusterName,
        addonName: "kube-proxy",
        addonVersion: "v1.25.14-eksbuild.2",
        resolveConflicts: "OVERWRITE",
    },
    {
        dependsOn: EBSIrsaRoleAttachment,
    },
);

const AddonVPC = new aws.eks.Addon(
    "AddonVPC",
    {
        clusterName: kubeClusterName,
        addonName: "vpc-cni",
        addonVersion: "v1.15.3-eksbuild.1",
        resolveConflicts: "OVERWRITE",
    },
    {
        dependsOn: EBSIrsaRoleAttachment,
    },
);

const AddonEBSDriver = new aws.eks.Addon(
    "AddonEBSDriver",
    {
        clusterName: kubeClusterName,
        addonName: "aws-ebs-csi-driver",
        addonVersion: "v1.24.0-eksbuild.1",
        resolveConflicts: "OVERWRITE",
        serviceAccountRoleArn: EBSIrsaRole.arn,
    },
    {
        dependsOn: EBSIrsaRoleAttachment,
    },
);

const AddonCoreDNS = new aws.eks.Addon(
    "AddonCoreDNS",
    {
        clusterName: kubeClusterName,
        addonName: "coredns",
        addonVersion: "v1.9.3-eksbuild.9",
        resolveConflicts: "OVERWRITE",
    },
    {
        dependsOn: EBSIrsaRoleAttachment,
    },
);

//Join a node group to EKS
const eksNodeGroup = new aws.eks.NodeGroup(
    "eksNodeGroup",
    {
        clusterName: kubeClusterName,
        diskSize: 10,
        instanceTypes: ["m6i.large"],
        nodeGroupName: "eksNodeGroup",
        nodeRoleArn: roleForNodeGroup.arn,
        scalingConfig: {
            desiredSize: 1,
            maxSize: 5,
            minSize: 1,
        },
        //Define the subnetIDs where the nodes should be created:
        subnetIds: [
            "subnet-x",
            "subnet-y",
            "subnet-z",
        ],
        updateConfig: {
            maxUnavailable: 2,
        },
    },
    {
        dependsOn: [cluster, K8sNGPolicy],
    },
);


//Autoscaler policy creation
const eksAutoscalingPolicy = new aws.iam.Policy("eksAutoscalingPolicy", {
    name: "autoScalingPolicy",
    policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                Action: [
                    "autoscaling:DescribeAutoScalingGroups",
                    "autoscaling:DescribeAutoScalingInstances",
                    "autoscaling:DescribeLaunchConfigurations",
                    "autoscaling:DescribeScalingActivities",
                    "autoscaling:DescribeTags",
                    "autoscaling:SetDesiredCapacity",
                    "autoscaling:TerminateInstanceInAutoScalingGroup",
                    "ec2:DescribeInstanceTypes",
                    "ec2:DescribeLaunchTemplateVersions",
                    "ec2:DescribeImages",
                    "ec2:GetInstanceTypesFromInstanceRequirements",
                    "eks:DescribeNodegroup"
                ],
                Effect: "Allow",
                Resource: ["*"],
            },
        ],
    }),
});

const eksAutoscalingRole = new aws.iam.Role(
    "eksAutoscalingRole",
    {
        assumeRolePolicy: pulumi
            .all([cluster.core.oidcProvider?.arn!, cluster.core.oidcProvider?.url!])
            .apply(([oidcArn, oidcUrl]) =>
                JSON.stringify({
                    Statement: [
                        {
                            Action: "sts:AssumeRoleWithWebIdentity",
                            Effect: "Allow",
                            Condition: {
                                StringEquals: {
                                    [`${oidcUrl}:sub`]:
                                        "system:serviceaccount:kube-system:eks-autoscaler",
                                },
                            },
                            Principal: {
                                Federated: oidcArn,
                            },
                        },
                    ],
                    Version: "2012-10-17",
                }),
            ),
    },
    {
        dependsOn: eksAutoscalingPolicy,
    },
);

//Polcy Attachment: autoscaler policy to autoscaler role
const autoscalerPolicyAttachment = new aws.iam.RolePolicyAttachment(
    "autoscalerPolicyAttachment",
    {
        policyArn: eksAutoscalingPolicy.arn,
        role: eksAutoscalingRole.name,
    },
    {
        dependsOn: roleForNodeGroup,
    },
);

//Install cluster autoscaler helm chart
const clusterAutoscaler = new k8s.helm.v3.Release(
    "cluster-autoscaler",
    {
        name: "cluster-autoscaler",
        chart: "cluster-autoscaler",
        namespace: "kube-system",
        repositoryOpts: {
            repo: "https://kubernetes.github.io/autoscaler",
        },
        values: {
            autoDiscovery: {
                clusterName: kubeClusterName,
            },
            awsRegion: "us-east-1",
            rbac: {
                serviceAccount: {
                    create: true,
                    name: "eks-autoscaler",
                    annotations: {
                        "eks.amazonaws.com/role-arn": eksAutoscalingRole.arn,
                    },
                },
            },
        },
    },
    {
        dependsOn: eksAutoscalingRole,
    },
);


//Argo CD Deployment
const argocdnamespace = new k8s.core.v1.Namespace("argonamespace", {
    metadata: {
        name: "argocd"
    }
});

const argocd = new k8s.helm.v3.Chart("argocd", {
    chart: "argo-cd",
    namespace: argocdnamespace.metadata.name,
    fetchOpts: {
        repo: "https://argoproj.github.io/argo-helm",
    },
    values: {
    },
},
    {
        dependsOn: argocdnamespace
    }
);

//We can now use this kube config to interact with the cluster:
export const kubeconfig = cluster.kubeconfig
